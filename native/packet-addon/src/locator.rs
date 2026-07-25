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
}

#[derive(Debug, Error)]
pub enum LocateError {
    #[error("wrapper.node is not loaded in this process")]
    ModuleNotLoaded,
    #[error("failed to query wrapper.node module information")]
    ModuleInfo,
    #[error(transparent)]
    Pe(#[from] PeError),
    #[error("send anchor was not found")]
    AnchorNotFound,
    #[error("send anchor has no RIP-relative xref")]
    XrefNotFound,
    #[error("send xref is not covered by .pdata")]
    FunctionNotFound,
}

pub fn locate_in_image(image: &[u8], module_base: usize) -> Result<LocatedBinding, LocateError> {
    let text = pe::section(image, ".text")?;
    let pdata = pe::section(image, ".pdata")?;
    let anchor_rva = pe::find_bytes(image, SEND_ANCHOR.as_bytes())
        .into_iter()
        .next()
        .ok_or(LocateError::AnchorNotFound)?;
    let xref_rva = pe::find_rip_relative_xrefs(image, text, anchor_rva)
        .into_iter()
        .next()
        .ok_or(LocateError::XrefNotFound)?;
    let functions = pe::runtime_functions(image, pdata);
    let function_rva = pe::containing_function(&functions, xref_rva)
        .ok_or(LocateError::FunctionNotFound)?
        .begin;
    Ok(LocatedBinding {
        module_base,
        anchor_rva,
        xref_rva,
        function_rva,
    })
}

#[cfg(windows)]
pub fn locate_loaded_wrapper() -> Result<LocatedBinding, LocateError> {
    use std::ffi::c_void;
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
    let image = unsafe {
        std::slice::from_raw_parts(info.lpBaseOfDll.cast::<u8>(), info.SizeOfImage as usize)
    };
    let _keep_type_visible: *const c_void = info.lpBaseOfDll;
    locate_in_image(image, info.lpBaseOfDll as usize)
}

#[cfg(not(windows))]
pub fn locate_loaded_wrapper() -> Result<LocatedBinding, LocateError> {
    Err(LocateError::ModuleNotLoaded)
}
