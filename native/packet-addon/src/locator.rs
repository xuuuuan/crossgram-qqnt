use crate::pe::{self, PeError};
use thiserror::Error;

pub const SEND_ANCHOR: &str =
    "assertion (argc == 2) failed: NodeIKernelMsgService::sendSsoCmdReqByContend needs 2 arguments";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocatedBinding {
    pub module_base: usize,
    pub anchor_rva: u32,
    pub xref_rva: u32,
    pub function_rva: u32,
    pub converter_rva: u32,
    pub response_rva: u32,
}

#[derive(Debug, Error)]
pub enum LocateError {
    #[error("wrapper.node is not loaded in this process")]
    ModuleNotLoaded,
    #[error("failed to query wrapper.node module information")]
    ModuleInfo,
    #[error("failed to snapshot readable wrapper.node memory")]
    ModuleSnapshot,
    #[error(transparent)]
    Pe(#[from] PeError),
    #[error("send anchor was not found")]
    AnchorNotFound,
    #[error("send anchor has no RIP-relative xref")]
    XrefNotFound,
    #[error("send xref is not covered by .pdata")]
    FunctionNotFound,
    #[error("send wrapper's adjacent argument converter was not found")]
    ConverterNotFound,
    #[error("send response callback was not found from its promise callback chain")]
    ResponseCallbackNotFound,
}

pub fn locate_in_image(image: &[u8], module_base: usize) -> Result<LocatedBinding, LocateError> {
    let text = pe::section(image, ".text")?;
    let rdata = pe::section(image, ".rdata")?;
    let pdata = pe::section(image, ".pdata")?;
    let anchor_rva = pe::find_bytes_in_section(image, rdata, SEND_ANCHOR.as_bytes())
        .into_iter()
        .next()
        .ok_or(LocateError::AnchorNotFound)?;
    let xref_rva = pe::find_rip_relative_xrefs(image, text, anchor_rva)
        .into_iter()
        .next()
        .ok_or(LocateError::XrefNotFound)?;
    let functions = pe::runtime_functions(image, pdata);
    let function =
        pe::containing_function(&functions, xref_rva).ok_or(LocateError::FunctionNotFound)?;
    let function_rva = function.begin;
    let converter_rva = pe::first_nearby_repeated_call_target(image, function)
        .filter(|target| {
            *target >= text.virtual_address
                && *target < text.virtual_address.saturating_add(text.virtual_size)
                && pe::containing_function(&functions, *target)
                    .is_some_and(|candidate| candidate.begin == *target)
        })
        .ok_or(LocateError::ConverterNotFound)?;
    let response_rva = response_callback_from_send_wrapper(
        image,
        module_base,
        text,
        rdata,
        &functions,
        function,
        converter_rva,
    )
    .ok_or(LocateError::ResponseCallbackNotFound)?;
    Ok(LocatedBinding {
        module_base,
        anchor_rva,
        xref_rva,
        function_rva,
        converter_rva,
        response_rva,
    })
}

fn response_callback_from_send_wrapper(
    image: &[u8],
    module_base: usize,
    text: pe::Section,
    rdata: pe::Section,
    functions: &[pe::RuntimeFunction],
    send_wrapper: pe::RuntimeFunction,
    converter_rva: u32,
) -> Option<u32> {
    let calls = pe::direct_calls(image, send_wrapper);
    let second_converter_call = calls.windows(2).find(|pair| {
        pair[0].1 == converter_rva
            && pair[1].1 == converter_rva
            && (8..=32).contains(&pair[1].0.saturating_sub(pair[0].0))
    })?[1]
        .0;

    // The generated wrapper keeps its promise-state helper immediately after
    // the wrapper body. This ties response discovery to the already located
    // send binding instead of choosing among hundreds of result/errMsg/rsp
    // wrappers in the module.
    let nearby_end = send_wrapper.end.saturating_add(0x1000);
    let promise_helper = calls
        .iter()
        .copied()
        .find(|(call, target)| {
            *call > second_converter_call
                && *target >= send_wrapper.end
                && *target < nearby_end
                && pe::containing_function(functions, *target)
                    .is_some_and(|function| function.begin == *target)
        })?
        .1;
    let promise_helper = pe::containing_function(functions, promise_helper)?;

    for (_, constructor_rva) in pe::direct_calls(image, promise_helper) {
        let Some(constructor) = pe::containing_function(functions, constructor_rva)
            .filter(|function| function.begin == constructor_rva)
        else {
            continue;
        };
        for (_, table_rva) in pe::rip_relative_lea_targets(image, constructor)
            .into_iter()
            .rev()
        {
            if table_rva < rdata.virtual_address
                || table_rva >= rdata.virtual_address.saturating_add(rdata.virtual_size)
            {
                continue;
            }
            let Some(callback_va) = table_rva
                .checked_add(8)
                .and_then(|address| pe::read_u64(image, address))
                .and_then(|address| usize::try_from(address).ok())
            else {
                continue;
            };
            let Some(callback_rva) = callback_va
                .checked_sub(module_base)
                .and_then(|value| u32::try_from(value).ok())
            else {
                continue;
            };
            if callback_rva < text.virtual_address
                || callback_rva >= text.virtual_address.saturating_add(text.virtual_size)
            {
                continue;
            }
            let Some(callback_entry) = pe::containing_function(functions, callback_rva)
                .filter(|function| function.begin == callback_rva)
            else {
                continue;
            };
            let local_end = callback_entry.end.saturating_add(0x1000);
            for (_, dispatcher_rva) in pe::direct_calls(image, callback_entry) {
                if dispatcher_rva < callback_entry.end || dispatcher_rva >= local_end {
                    continue;
                }
                let Some(dispatcher) = pe::containing_function(functions, dispatcher_rva)
                    .filter(|function| function.begin == dispatcher_rva)
                else {
                    continue;
                };
                for (_, thunk_rva) in pe::rip_relative_lea_targets(image, dispatcher) {
                    let Some(response_rva) = pe::indirect_rcx_jump_target(image, thunk_rva) else {
                        continue;
                    };
                    if pe::containing_function(functions, response_rva)
                        .is_some_and(|function| function.begin == response_rva)
                    {
                        return Some(response_rva);
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    fn write_call(image: &mut [u8], instruction: u32, target: u32) {
        image[instruction as usize] = 0xe8;
        let displacement = target as i32 - instruction as i32 - 5;
        image[instruction as usize + 1..instruction as usize + 5]
            .copy_from_slice(&displacement.to_le_bytes());
    }

    fn write_lea(image: &mut [u8], instruction: u32, target: u32) {
        image[instruction as usize..instruction as usize + 3].copy_from_slice(&[0x4c, 0x8d, 0x05]);
        let displacement = target as i32 - instruction as i32 - 7;
        image[instruction as usize + 3..instruction as usize + 7]
            .copy_from_slice(&displacement.to_le_bytes());
    }

    #[test]
    fn follows_the_send_wrappers_own_response_callback_chain() {
        const MODULE_BASE: usize = 0x0001_8000_0000;
        let mut image = vec![0x90u8; 0xb00];
        let send_wrapper = pe::RuntimeFunction {
            begin: 0x100,
            end: 0x180,
        };
        let functions = [
            send_wrapper,
            pe::RuntimeFunction {
                begin: 0x190,
                end: 0x1c0,
            },
            pe::RuntimeFunction {
                begin: 0x250,
                end: 0x2c0,
            },
            pe::RuntimeFunction {
                begin: 0x400,
                end: 0x480,
            },
            pe::RuntimeFunction {
                begin: 0x500,
                end: 0x560,
            },
            pe::RuntimeFunction {
                begin: 0x600,
                end: 0x680,
            },
            pe::RuntimeFunction {
                begin: 0x700,
                end: 0x740,
            },
        ];

        write_call(&mut image, 0x110, 0x700);
        write_call(&mut image, 0x120, 0x700);
        write_call(&mut image, 0x140, 0x190);
        write_call(&mut image, 0x1a0, 0x250);
        write_lea(&mut image, 0x260, 0x900);
        image[0x908..0x910].copy_from_slice(&((MODULE_BASE + 0x400) as u64).to_le_bytes());
        write_call(&mut image, 0x420, 0x500);
        write_lea(&mut image, 0x510, 0x580);
        image[0x580..0x584].copy_from_slice(&[0x48, 0x8b, 0x09, 0xe9]);
        image[0x584..0x588].copy_from_slice(&(0x600i32 - 0x580 - 8).to_le_bytes());

        assert_eq!(
            response_callback_from_send_wrapper(
                &image,
                MODULE_BASE,
                pe::Section {
                    virtual_address: 0x100,
                    virtual_size: 0x700,
                },
                pe::Section {
                    virtual_address: 0x900,
                    virtual_size: 0x100,
                },
                &functions,
                send_wrapper,
                0x700,
            ),
            Some(0x600),
        );
    }
}

#[cfg(windows)]
pub fn locate_loaded_wrapper() -> Result<LocatedBinding, LocateError> {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::ProcessStatus::{GetModuleInformation, MODULEINFO};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let name: Vec<u16> = "wrapper.node\0".encode_utf16().collect();
    let module = unsafe { GetModuleHandleW(name.as_ptr()) };
    if module.is_null() {
        return Err(LocateError::ModuleNotLoaded);
    }
    let mut info = MODULEINFO {
        lpBaseOfDll: std::ptr::null_mut(),
        SizeOfImage: 0,
        EntryPoint: std::ptr::null_mut(),
    };
    let ok = unsafe {
        GetModuleInformation(
            GetCurrentProcess(),
            module,
            &mut info,
            std::mem::size_of::<MODULEINFO>() as u32,
        )
    };
    if ok == 0 || info.lpBaseOfDll.is_null() || info.SizeOfImage == 0 {
        return Err(LocateError::ModuleInfo);
    }
    let image = snapshot_readable_image(info.lpBaseOfDll.cast::<u8>(), info.SizeOfImage as usize)?;
    locate_in_image(&image, info.lpBaseOfDll as usize)
}

#[cfg(windows)]
fn snapshot_readable_image(base: *const u8, size: usize) -> Result<Vec<u8>, LocateError> {
    use std::ffi::c_void;
    use windows_sys::Win32::System::Memory::{
        MEM_COMMIT, MEMORY_BASIC_INFORMATION, PAGE_EXECUTE_READ, PAGE_EXECUTE_READWRITE,
        PAGE_EXECUTE_WRITECOPY, PAGE_GUARD, PAGE_NOACCESS, PAGE_READONLY, PAGE_READWRITE,
        PAGE_WRITECOPY, VirtualQuery,
    };

    let start = base as usize;
    let end = start.checked_add(size).ok_or(LocateError::ModuleSnapshot)?;
    let mut image = vec![0u8; size];
    let mut cursor = start;
    while cursor < end {
        let mut region = MEMORY_BASIC_INFORMATION::default();
        let queried = unsafe {
            VirtualQuery(
                cursor as *const c_void,
                &mut region,
                std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
            )
        };
        if queried == 0 || region.RegionSize == 0 {
            return Err(LocateError::ModuleSnapshot);
        }
        let region_start = region.BaseAddress as usize;
        let region_end = region_start
            .checked_add(region.RegionSize)
            .ok_or(LocateError::ModuleSnapshot)?;
        let copy_start = cursor.max(region_start);
        let copy_end = end.min(region_end);
        if copy_end <= copy_start {
            return Err(LocateError::ModuleSnapshot);
        }
        let access = region.Protect & 0xff;
        let readable = matches!(
            access,
            PAGE_READONLY
                | PAGE_READWRITE
                | PAGE_WRITECOPY
                | PAGE_EXECUTE_READ
                | PAGE_EXECUTE_READWRITE
                | PAGE_EXECUTE_WRITECOPY
        );
        if region.State == MEM_COMMIT
            && readable
            && region.Protect & (PAGE_GUARD | PAGE_NOACCESS) == 0
        {
            unsafe {
                std::ptr::copy_nonoverlapping(
                    copy_start as *const u8,
                    image.as_mut_ptr().add(copy_start - start),
                    copy_end - copy_start,
                );
            }
        }
        cursor = copy_end;
    }
    Ok(image)
}

#[cfg(not(windows))]
pub fn locate_loaded_wrapper() -> Result<LocatedBinding, LocateError> {
    Err(LocateError::ModuleNotLoaded)
}
