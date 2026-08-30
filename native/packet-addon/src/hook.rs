use crate::locator::LocatedBinding;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum HookError {
    #[cfg(not(any(windows, target_os = "linux")))]
    #[error("QQNT Buffer conversion hook is only supported on Windows and Linux")]
    Unsupported,
    #[error("QQNT packet hook was already installed at a different address")]
    DifferentTarget,
    #[error("failed to create QQNT packet hook: {0}")]
    Create(String),
    #[error("failed to enable QQNT packet hook: {0}")]
    Enable(String),
}

#[derive(Debug, Clone)]
pub struct ReceivePacket {
    pub uin: String,
    pub command: String,
    pub sequence: u64,
    pub payload: Vec<u8>,
}

#[cfg(windows)]
mod windows {
    use super::*;
    use minhook::MinHook;
    use napi::sys::{
        napi_close_handle_scope, napi_create_buffer_copy, napi_create_int32, napi_create_object,
        napi_create_string_utf8, napi_deferred, napi_env, napi_get_buffer_info, napi_handle_scope,
        napi_is_buffer, napi_open_handle_scope, napi_resolve_deferred, napi_set_named_property,
        napi_value,
    };
    use std::ffi::c_void;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    type Converter = unsafe extern "C" fn(*mut u8, napi_env, napi_value) -> *mut u8;
    type ResponseCallback = unsafe extern "C" fn(*mut u8);

    static INSTALL_LOCK: Mutex<()> = Mutex::new(());
    static ORIGINAL_CONVERTER: AtomicUsize = AtomicUsize::new(0);
    static ORIGINAL_RESPONSE_CALLBACK: AtomicUsize = AtomicUsize::new(0);
    static HOOK_TARGET: AtomicUsize = AtomicUsize::new(0);

    pub fn install(location: &LocatedBinding) -> Result<(), HookError> {
        let target = location
            .module_base
            .checked_add(location.converter_rva as usize)
            .ok_or(HookError::DifferentTarget)?;
        let response_target = location
            .module_base
            .checked_add(location.response_rva as usize)
            .ok_or(HookError::DifferentTarget)?;
        let installed = HOOK_TARGET.load(Ordering::Acquire);
        if installed == target {
            return Ok(());
        }
        if installed != 0 {
            return Err(HookError::DifferentTarget);
        }

        let _guard = INSTALL_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let installed = HOOK_TARGET.load(Ordering::Acquire);
        if installed == target {
            return Ok(());
        }
        if installed != 0 {
            return Err(HookError::DifferentTarget);
        }

        let target_ptr = target as *mut c_void;
        let response_target_ptr = response_target as *mut c_void;
        let converter_trampoline = unsafe {
            MinHook::create_hook(target_ptr, buffer_converter as *const () as *mut c_void)
        }
        .map_err(|status| HookError::Create(status.to_string()))?;
        ORIGINAL_CONVERTER.store(converter_trampoline as usize, Ordering::Release);
        let response_trampoline = match unsafe {
            MinHook::create_hook(
                response_target_ptr,
                response_callback as *const () as *mut c_void,
            )
        } {
            Ok(trampoline) => trampoline,
            Err(status) => {
                ORIGINAL_CONVERTER.store(0, Ordering::Release);
                let _ = unsafe { MinHook::remove_hook(target_ptr) };
                return Err(HookError::Create(status.to_string()));
            }
        };
        ORIGINAL_RESPONSE_CALLBACK.store(response_trampoline as usize, Ordering::Release);

        if let Err(status) = unsafe { MinHook::queue_enable_hook(target_ptr) }
            .and_then(|_| unsafe { MinHook::queue_enable_hook(response_target_ptr) })
            .and_then(|_| unsafe { MinHook::apply_queued() })
        {
            ORIGINAL_CONVERTER.store(0, Ordering::Release);
            ORIGINAL_RESPONSE_CALLBACK.store(0, Ordering::Release);
            let _ = unsafe { MinHook::remove_hook(target_ptr) };
            let _ = unsafe { MinHook::remove_hook(response_target_ptr) };
            return Err(HookError::Enable(status.to_string()));
        }
        HOOK_TARGET.store(target, Ordering::Release);
        Ok(())
    }

    unsafe extern "C" fn response_callback(task: *mut u8) {
        let original_address = ORIGINAL_RESPONSE_CALLBACK.load(Ordering::Acquire);
        if original_address == 0 {
            return;
        }
        let original: ResponseCallback = unsafe { std::mem::transmute(original_address) };
        if task.is_null() {
            return unsafe { original(task) };
        }

        // QQNT's generated promise callback owns a shared state pointer at
        // +0x10. The state contains napi_env/+0x18 and napi_deferred/+0x20;
        // the response carries result/+0x18, errMsg/+0x20 and bytes/+0x38.
        let state = unsafe { task.add(0x10).cast::<*mut u8>().read_unaligned() };
        if state.is_null() {
            return unsafe { original(task) };
        }
        let env = unsafe { state.add(0x18).cast::<napi_env>().read_unaligned() };
        let deferred = unsafe { state.add(0x20).cast::<napi_deferred>().read_unaligned() };
        if env.is_null() || deferred.is_null() {
            return unsafe { original(task) };
        }

        let result_code = unsafe { task.add(0x18).cast::<i32>().read_unaligned() };
        let Some((error_data, error_length)) = (unsafe { qq_string_bytes(task.add(0x20)) }) else {
            return unsafe { original(task) };
        };
        let Some((response_data, response_length)) = (unsafe { qq_string_bytes(task.add(0x38)) })
        else {
            return unsafe { original(task) };
        };
        const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
        const MAX_ERROR_BYTES: usize = 1024 * 1024;
        if response_length > MAX_RESPONSE_BYTES || error_length > MAX_ERROR_BYTES {
            return unsafe { original(task) };
        }

        let mut scope: napi_handle_scope = std::ptr::null_mut();
        if unsafe { napi_open_handle_scope(env, &mut scope) } != 0 || scope.is_null() {
            return unsafe { original(task) };
        }
        let converted = unsafe {
            convert_response(
                env,
                deferred,
                result_code,
                error_data,
                error_length,
                response_data,
                response_length,
            )
        };
        let _ = unsafe { napi_close_handle_scope(env, scope) };
        if converted {
            unsafe {
                state
                    .add(0x20)
                    .cast::<napi_deferred>()
                    .write_unaligned(std::ptr::null_mut())
            };
        } else {
            unsafe { original(task) };
        }
    }

    #[allow(clippy::too_many_arguments)]
    unsafe fn convert_response(
        env: napi_env,
        deferred: napi_deferred,
        result_code: i32,
        error_data: *const u8,
        error_length: usize,
        response_data: *const u8,
        response_length: usize,
    ) -> bool {
        let mut object: napi_value = std::ptr::null_mut();
        let mut result_value: napi_value = std::ptr::null_mut();
        let mut error_value: napi_value = std::ptr::null_mut();
        let mut response_value: napi_value = std::ptr::null_mut();
        if unsafe { napi_create_object(env, &mut object) } != 0
            || unsafe { napi_create_int32(env, result_code, &mut result_value) } != 0
            || unsafe { napi_set_named_property(env, object, c"result".as_ptr(), result_value) }
                != 0
            || unsafe {
                napi_create_string_utf8(
                    env,
                    error_data.cast(),
                    error_length as isize,
                    &mut error_value,
                )
            } != 0
            || unsafe { napi_set_named_property(env, object, c"errMsg".as_ptr(), error_value) } != 0
            || unsafe {
                napi_create_buffer_copy(
                    env,
                    response_length,
                    response_data.cast(),
                    std::ptr::null_mut(),
                    &mut response_value,
                )
            } != 0
            || unsafe {
                napi_set_named_property(env, object, c"rspbuffer".as_ptr(), response_value)
            } != 0
            || unsafe { napi_resolve_deferred(env, deferred, object) } != 0
        {
            return false;
        }
        true
    }

    unsafe extern "C" fn buffer_converter(
        destination: *mut u8,
        env: napi_env,
        value: napi_value,
    ) -> *mut u8 {
        let original_address = ORIGINAL_CONVERTER.load(Ordering::Acquire);
        if original_address == 0 {
            return destination;
        }
        let original: Converter = unsafe { std::mem::transmute(original_address) };

        let mut is_buffer = false;
        if unsafe { napi_is_buffer(env, value, &mut is_buffer) } != 0 || !is_buffer {
            return unsafe { original(destination, env, value) };
        }

        let mut data: *mut c_void = std::ptr::null_mut();
        let mut length = 0usize;
        if unsafe { napi_get_buffer_info(env, value, &mut data, &mut length) } != 0
            || (length != 0 && data.is_null())
            || length > isize::MAX as usize
        {
            return unsafe { original(destination, env, value) };
        }

        // Let QQNT's original converter allocate and initialize its private
        // string representation, then replace the same-length ASCII payload
        // with the Buffer bytes. This keeps allocation and destruction on
        // QQNT's own ABI without relying on a version-specific malloc RVA.
        let mut placeholder: Vec<u8> = Vec::new();
        if placeholder.try_reserve_exact(length).is_err() {
            return unsafe { original(destination, env, value) };
        }
        unsafe {
            placeholder.set_len(length);
            std::ptr::write_bytes(placeholder.as_mut_ptr(), b'A', length);
        }
        let mut placeholder_value: napi_value = std::ptr::null_mut();
        if unsafe {
            napi_create_string_utf8(
                env,
                placeholder.as_ptr().cast(),
                length as isize,
                &mut placeholder_value,
            )
        } != 0
            || placeholder_value.is_null()
        {
            return unsafe { original(destination, env, value) };
        }

        let result = unsafe { original(destination, env, placeholder_value) };
        if let Some(output) = unsafe { qq_string_payload(result, length) }
            && length != 0
        {
            unsafe { std::ptr::copy_nonoverlapping(data.cast::<u8>(), output, length) };
        }
        result
    }

    unsafe fn qq_string_payload(value: *mut u8, expected_length: usize) -> Option<*mut u8> {
        if value.is_null() {
            return None;
        }
        let tag = unsafe { *value };
        if tag & 1 == 0 {
            ((tag as usize >> 1) == expected_length).then(|| unsafe { value.add(1) })
        } else {
            let length = unsafe { value.add(8).cast::<usize>().read_unaligned() };
            let data = unsafe { value.add(16).cast::<*mut u8>().read_unaligned() };
            (length == expected_length && (!data.is_null() || length == 0)).then_some(data)
        }
    }

    unsafe fn qq_string_bytes(value: *const u8) -> Option<(*const u8, usize)> {
        if value.is_null() {
            return None;
        }
        let tag = unsafe { *value };
        if tag & 1 == 0 {
            Some((unsafe { value.add(1) }, tag as usize >> 1))
        } else {
            let length = unsafe { value.add(8).cast::<usize>().read_unaligned() };
            let data = unsafe { value.add(16).cast::<*const u8>().read_unaligned() };
            (!data.is_null() || length == 0).then_some((data, length))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn resolves_small_and_heap_qq_strings() {
            let mut small = [0u8; 24];
            small[0] = 10;
            assert_eq!(
                unsafe { qq_string_payload(small.as_mut_ptr(), 5) },
                Some(unsafe { small.as_mut_ptr().add(1) }),
            );
            assert!(unsafe { qq_string_payload(small.as_mut_ptr(), 4) }.is_none());

            let mut heap_data = [0u8; 32];
            let mut heap = [0u8; 24];
            heap[0] = 1;
            heap[8..16].copy_from_slice(&32usize.to_ne_bytes());
            heap[16..24].copy_from_slice(&(heap_data.as_mut_ptr() as usize).to_ne_bytes());
            assert_eq!(
                unsafe { qq_string_payload(heap.as_mut_ptr(), 32) },
                Some(heap_data.as_mut_ptr()),
            );
            assert_eq!(
                unsafe { qq_string_bytes(small.as_ptr()) },
                Some((unsafe { small.as_ptr().add(1) }, 5)),
            );
            assert_eq!(
                unsafe { qq_string_bytes(heap.as_ptr()) },
                Some((heap_data.as_ptr(), 32)),
            );
        }
    }
}

// Linux inline-hook installer.
//
// Two function-entry patches are installed before wrapper.node's exports are
// handed back to QQNT (during `process.dlopen`), so no thread is executing
// these functions while their prologue is being rewritten:
//
//  * converter (0x63f47b0) -> shim_converter: preserves a Node Buffer's raw
//    bytes when QQNT's argument converter would otherwise coerce it to a UTF-8
//    string. The shim delegates to the original via a relocated trampoline.
//  * resolver (0x34b9e30) -> shim_resolver: replaces QQNT's promise resolver
//    (which runs on the libuv JS thread) so the protobuf `rsp` field is exposed
//    as a binary `rspbuffer` Buffer instead of a lossy UTF-8 string. The
//    original is not called back; the deferred is nulled after resolve.
//
// The XRef locator verifies both targets against the on-disk image before the
// hook is installed. Both targets begin with `push r15; push r14; push rbx`
// (41 57 41 56 53), which contains no RIP-relative addressing and therefore
// relocates verbatim into a trampoline.
#[cfg(target_os = "linux")]
mod linux {
    use super::HookError;
    use crate::elf::PacketBindingProbe;
    use napi::sys::{
        napi_close_handle_scope, napi_create_buffer_copy, napi_create_int32, napi_create_object,
        napi_create_string_utf8, napi_deferred, napi_env, napi_get_buffer_info, napi_handle_scope,
        napi_is_buffer, napi_open_handle_scope, napi_resolve_deferred, napi_set_named_property,
        napi_value,
    };
    use std::collections::VecDeque;
    use std::ffi::c_void;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    type Converter = unsafe extern "C" fn(*mut u8, napi_env, napi_value);
    const PAGE_SIZE: usize = 0x1000;
    const MAP_FIXED_NOREPLACE: libc::c_int = 0x100_0000;
    // Stay inside a 32-bit signed displacement so a 5-byte `jmp rel32` from the
    // target always reaches the near-page stub.
    const NEAR_LIMIT: u64 = 0x7FFF_F000;
    const PROLOGUE: [u8; 5] = [0x41, 0x57, 0x41, 0x56, 0x53];
    const OFF_CONV_TRAMP: usize = 0; // 5 relocated bytes + E9 rel32 = 10
    const OFF_CONV_STUB: usize = 16; // FF 25 .. + abs ptr = 14
    const OFF_RESOLVER_STUB: usize = 32; // 14

    static INSTALL_LOCK: Mutex<()> = Mutex::new(());
    static ORIGINAL_CONVERTER: AtomicUsize = AtomicUsize::new(0);
    static CONVERTER_TARGET: AtomicUsize = AtomicUsize::new(0);
    static RESOLVER_TARGET: AtomicUsize = AtomicUsize::new(0);
    static RECEIVE_TARGET: AtomicUsize = AtomicUsize::new(0);
    static ORIGINAL_RECEIVE: AtomicUsize = AtomicUsize::new(0);
    static RECEIVE_PAGE: AtomicUsize = AtomicUsize::new(0);
    static RECEIVE_QUEUE: Mutex<VecDeque<super::ReceivePacket>> = Mutex::new(VecDeque::new());
    static RECEIVE_QUEUE_BYTES: AtomicUsize = AtomicUsize::new(0);
    const RECEIVE_PROLOGUE: [u8; 5] = [0x55, 0x41, 0x57, 0x41, 0x56];
    const RECEIVE_STUB_OFFSET: usize = 64;
    const MAX_RECEIVE_PAYLOAD: usize = 1024 * 1024;
    const MAX_RECEIVE_QUEUE_BYTES: usize = 8 * 1024 * 1024;
    const MAX_RECEIVE_STRING: usize = 4096;

    pub fn drain_receive_packets() -> Vec<super::ReceivePacket> {
        let mut queue = RECEIVE_QUEUE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let packets: Vec<_> = queue.drain(..).collect();
        RECEIVE_QUEUE_BYTES.store(0, Ordering::Release);
        packets
    }

    pub fn install_receive(probe: &PacketBindingProbe) -> Result<u64, HookError> {
        let receive_rva = probe.receive_rva as usize;
        if receive_rva == 0 {
            return Err(HookError::Create(
                "MSF receive handler xref was not found".into(),
            ));
        }

        let target = probe
            .module_base
            .checked_add(receive_rva)
            .ok_or_else(|| HookError::Create("receive address overflow".into()))?;
        if RECEIVE_TARGET.load(Ordering::Acquire) == target {
            return Ok(probe.receive_rva);
        }
        if RECEIVE_TARGET.load(Ordering::Acquire) != 0 {
            return Err(HookError::DifferentTarget);
        }
        let _guard = INSTALL_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if RECEIVE_TARGET.load(Ordering::Acquire) == target {
            return Ok(probe.receive_rva);
        }
        if RECEIVE_TARGET.load(Ordering::Acquire) != 0 {
            return Err(HookError::DifferentTarget);
        }
        let prologue = unsafe { std::ptr::read_unaligned(target as *const [u8; 5]) };
        if prologue != RECEIVE_PROLOGUE {
            return Err(HookError::Create(format!(
                "receive target prologue {prologue:02x?} does not match expected {:02x?}",
                RECEIVE_PROLOGUE,
            )));
        }
        let near = alloc_near(target, PAGE_SIZE)?;
        let page = near as *mut u8;
        unsafe {
            std::ptr::copy_nonoverlapping(target as *const u8, page, 5);
            let jmp_at = page.add(5);
            *jmp_at = 0xE9;
            let rel = (target as isize)
                .wrapping_add(5)
                .wrapping_sub((near + 10) as isize);
            write_i32(jmp_at.add(1), rel as i32);
            write_abs_jmp(
                page.add(RECEIVE_STUB_OFFSET),
                shim_receive as *const () as usize,
            );
        }
        mprotect_rw(near, PAGE_SIZE)
            .and_then(|()| mprotect_rx(near, PAGE_SIZE))
            .map_err(|error| {
                unsafe { libc::munmap(near as *mut c_void, PAGE_SIZE) };
                error
            })?;
        ORIGINAL_RECEIVE.store(near, Ordering::Release);
        if let Err(error) = patch_rel32_jmp(target, near + RECEIVE_STUB_OFFSET) {
            ORIGINAL_RECEIVE.store(0, Ordering::Release);
            unsafe { libc::munmap(near as *mut c_void, PAGE_SIZE) };
            return Err(error);
        }
        RECEIVE_PAGE.store(near, Ordering::Release);
        RECEIVE_TARGET.store(target, Ordering::Release);
        Ok(probe.receive_rva)
    }

    unsafe extern "C" fn shim_receive(arg1: *mut u8, rec: *mut u8, arg3: *mut u8) -> i64 {
        if let Some(packet) = unsafe { parse_receive_packet(rec) } {
            let mut queue = RECEIVE_QUEUE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let packet_size = packet.payload.len();
            while (!queue.is_empty()
                && RECEIVE_QUEUE_BYTES
                    .load(Ordering::Acquire)
                    .saturating_add(packet_size)
                    > MAX_RECEIVE_QUEUE_BYTES)
                || queue.len() >= 2048
            {
                if let Some(old) = queue.pop_front() {
                    RECEIVE_QUEUE_BYTES.fetch_sub(old.payload.len(), Ordering::AcqRel);
                }
            }
            RECEIVE_QUEUE_BYTES.fetch_add(packet_size, Ordering::AcqRel);
            queue.push_back(packet);
        }
        let trampoline = ORIGINAL_RECEIVE.load(Ordering::Acquire);
        if trampoline == 0 {
            return 0;
        }
        let original: unsafe extern "C" fn(*mut u8, *mut u8, *mut u8) -> i64 =
            unsafe { std::mem::transmute(trampoline) };
        unsafe { original(arg1, rec, arg3) }
    }

    unsafe fn parse_receive_packet(rec: *mut u8) -> Option<super::ReceivePacket> {
        if rec.is_null() {
            return None;
        }
        // The receive callback runs on QQ's networking threads.  A malformed
        // or already-released packet must not turn into a process crash, so all
        // memory originating from QQ is copied through process_vm_readv.  The
        // syscall returns EFAULT for an invalid range instead of faulting us.
        let mut record = [0u8; 64];
        if !read_process_memory(rec.cast_const(), &mut record) {
            return None;
        }
        // Current QQNT wraps the receive record in an outer pointer.  The
        // pointed-to object stores command at +0x20 and the byte range at
        // +0x38.  Keep the older direct layout as a fallback for other builds.
        let inner = usize::from_ne_bytes(record[0..8].try_into().ok()?) as *const u8;
        if !inner.is_null() {
            let mut inner_record = [0u8; 0x48];
            if read_process_memory(inner, &mut inner_record) {
                if let Some(command) = read_qq_string_bytes(&inner_record, 0x20) {
                    let buffer = usize::from_ne_bytes(inner_record[0x38..0x40].try_into().ok()?)
                        as *const u8;
                    if let Some(payload) = read_receive_payload(buffer) {
                        return Some(super::ReceivePacket {
                            uin: String::new(),
                            command: String::from_utf8_lossy(&command).into_owned(),
                            sequence: 0,
                            payload,
                        });
                    }
                }
            }
        }

        let uin = read_qq_string_bytes(&record, 0)?;
        let command = read_qq_string_bytes(&record, 32)?;
        let sequence = u32::from_ne_bytes(record[24..28].try_into().ok()?) as u64;
        let buffer = usize::from_ne_bytes(record[56..64].try_into().ok()?) as *const u8;
        let payload = read_receive_payload(buffer)?;
        Some(super::ReceivePacket {
            uin: String::from_utf8_lossy(&uin).into_owned(),
            command: String::from_utf8_lossy(&command).into_owned(),
            sequence,
            payload,
        })
    }

    fn read_receive_payload(buffer: *const u8) -> Option<Vec<u8>> {
        if buffer.is_null() {
            return None;
        }
        let mut buffer_range = [0u8; 16];
        if !read_process_memory(buffer, &mut buffer_range) {
            return None;
        }
        let start = usize::from_ne_bytes(buffer_range[0..8].try_into().ok()?) as *const u8;
        let end = usize::from_ne_bytes(buffer_range[8..16].try_into().ok()?) as *const u8;
        if start.is_null() || end.is_null() || end < start {
            return None;
        }
        let length = (end as usize).checked_sub(start as usize)?;
        if length == 0 || length > MAX_RECEIVE_PAYLOAD {
            return None;
        }
        let mut payload = vec![0u8; length];
        read_process_memory(start, &mut payload).then_some(payload)
    }

    fn read_process_memory(address: *const u8, destination: &mut [u8]) -> bool {
        if address.is_null() {
            return false;
        }
        if destination.is_empty() {
            return true;
        }
        let local = libc::iovec {
            iov_base: destination.as_mut_ptr().cast(),
            iov_len: destination.len(),
        };
        let remote = libc::iovec {
            iov_base: address.cast_mut().cast(),
            iov_len: destination.len(),
        };
        let copied = unsafe { libc::process_vm_readv(libc::getpid(), &local, 1, &remote, 1, 0) };
        copied == destination.len() as isize
    }

    fn read_qq_string_bytes(record: &[u8], offset: usize) -> Option<Vec<u8>> {
        let end = offset.checked_add(24)?;
        if end > record.len() {
            return None;
        }
        let tag = record[offset];
        if tag & 1 == 0 {
            let length = (tag as usize) >> 1;
            let data_end = offset.checked_add(1)?.checked_add(length)?;
            return (data_end <= record.len()).then(|| record[offset + 1..data_end].to_vec());
        }
        let length = usize::from_ne_bytes(record[offset + 8..offset + 16].try_into().ok()?);
        if length > MAX_RECEIVE_STRING {
            return None;
        }
        let data =
            usize::from_ne_bytes(record[offset + 16..offset + 24].try_into().ok()?) as *const u8;
        let mut bytes = vec![0u8; length];
        (length == 0 || read_process_memory(data, &mut bytes)).then_some(bytes)
    }

    unsafe fn read_qq_string(rec: *mut u8, offset: usize) -> Option<Vec<u8>> {
        let value = unsafe { rec.add(offset) };
        let tag = unsafe { *value };
        let (data, length) = if tag & 1 == 0 {
            (unsafe { value.add(1).cast_const() }, (tag as usize) >> 1)
        } else {
            let length = unsafe { value.add(8).cast::<usize>().read_unaligned() };
            let data = unsafe { value.add(16).cast::<*const u8>().read_unaligned() };
            (data, length)
        };
        if length > MAX_RECEIVE_STRING || (length != 0 && data.is_null()) {
            return None;
        }
        Some(unsafe { std::slice::from_raw_parts(data, length).to_vec() })
    }

    pub fn install(probe: &PacketBindingProbe) -> Result<(), HookError> {
        let base = probe.module_base;
        let converter = base
            .checked_add(probe.converter_rva as usize)
            .ok_or_else(|| HookError::Create("converter address overflow".into()))?;
        let resolver = base
            .checked_add(probe.resolve_action_rva as usize)
            .ok_or_else(|| HookError::Create("resolver address overflow".into()))?;

        if already_installed(converter, resolver) {
            return Ok(());
        }
        if CONVERTER_TARGET.load(Ordering::Acquire) != 0
            || RESOLVER_TARGET.load(Ordering::Acquire) != 0
        {
            return Err(HookError::DifferentTarget);
        }

        let _guard = INSTALL_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if already_installed(converter, resolver) {
            return Ok(());
        }
        if CONVERTER_TARGET.load(Ordering::Acquire) != 0
            || RESOLVER_TARGET.load(Ordering::Acquire) != 0
        {
            return Err(HookError::DifferentTarget);
        }

        verify_prologue(converter)?;
        verify_prologue(resolver)?;

        // The two targets sit ~50 MiB apart, so a single page within 2 GiB of
        // the converter is also within reach of the resolver.
        let near = alloc_near(converter, PAGE_SIZE)?;
        let page = near as *mut u8;
        unsafe {
            // Converter trampoline: original 5 bytes + jmp rel32 back to the
            // instruction after the patched prologue.
            std::ptr::copy_nonoverlapping(converter as *const u8, page.add(OFF_CONV_TRAMP), 5);
            let jmp_at = page.add(OFF_CONV_TRAMP + 5);
            *jmp_at = 0xE9;
            let rel = (converter as isize)
                .wrapping_add(5)
                .wrapping_sub((near + OFF_CONV_TRAMP + 10) as isize);
            write_i32(jmp_at.add(1), rel as i32);
            write_abs_jmp(
                page.add(OFF_CONV_STUB),
                shim_converter as *const () as usize,
            );
            write_abs_jmp(
                page.add(OFF_RESOLVER_STUB),
                shim_resolver as *const () as usize,
            );
        }
        mprotect_rw(near, PAGE_SIZE)
            .and_then(|()| mprotect_rx(near, PAGE_SIZE))
            .map_err(|e| {
                unsafe { libc::munmap(near as *mut c_void, PAGE_SIZE) };
                e
            })?;

        // Publish the trampoline before rewiring the target so the shim always
        // sees a valid original.
        ORIGINAL_CONVERTER.store(near + OFF_CONV_TRAMP, Ordering::Release);

        if let Err(error) = patch_rel32_jmp(converter, near + OFF_CONV_STUB) {
            ORIGINAL_CONVERTER.store(0, Ordering::Release);
            unsafe { libc::munmap(near as *mut c_void, PAGE_SIZE) };
            return Err(error);
        }
        if let Err(error) = patch_rel32_jmp(resolver, near + OFF_RESOLVER_STUB) {
            let _ = unpatch(converter);
            ORIGINAL_CONVERTER.store(0, Ordering::Release);
            unsafe { libc::munmap(near as *mut c_void, PAGE_SIZE) };
            return Err(error);
        }

        CONVERTER_TARGET.store(converter, Ordering::Release);
        RESOLVER_TARGET.store(resolver, Ordering::Release);
        Ok(())
    }

    fn already_installed(converter: usize, resolver: usize) -> bool {
        CONVERTER_TARGET.load(Ordering::Acquire) == converter
            && RESOLVER_TARGET.load(Ordering::Acquire) == resolver
    }

    fn verify_prologue(target: usize) -> Result<(), HookError> {
        let bytes = unsafe { std::ptr::read_unaligned(target as *const [u8; 5]) };
        if bytes == PROLOGUE {
            Ok(())
        } else {
            Err(HookError::Create(format!(
                "target prologue {bytes:02x?} does not match expected {:02x?}",
                PROLOGUE
            )))
        }
    }

    fn errno() -> i32 {
        unsafe { *libc::__errno_location() }
    }

    fn mprotect_rw(addr: usize, len: usize) -> Result<(), HookError> {
        if unsafe { libc::mprotect(addr as *mut c_void, len, libc::PROT_READ | libc::PROT_WRITE) }
            != 0
        {
            Err(HookError::Create(format!(
                "mprotect RW failed errno={}",
                errno()
            )))
        } else {
            Ok(())
        }
    }

    fn mprotect_rx(addr: usize, len: usize) -> Result<(), HookError> {
        // The freshly-mapped stub page must end executable; force READ|EXEC
        // rather than restoring its mmap-time RW protection.
        if unsafe { libc::mprotect(addr as *mut c_void, len, libc::PROT_READ | libc::PROT_EXEC) }
            != 0
        {
            Err(HookError::Create(format!(
                "mprotect RX failed errno={}",
                errno()
            )))
        } else {
            Ok(())
        }
    }

    fn write_i32(at: *mut u8, value: i32) {
        unsafe { std::ptr::copy_nonoverlapping(value.to_ne_bytes().as_ptr(), at, 4) };
    }

    /// Writes `jmp qword ptr [rip+0]; <abs>` (14 bytes) — an absolute indirect
    /// jump used by the in-range stubs to reach the Rust shim wherever it lands.
    fn write_abs_jmp(at: *mut u8, target: usize) {
        unsafe {
            std::ptr::copy_nonoverlapping([0xFFu8, 0x25, 0, 0, 0, 0].as_ptr(), at, 6);
            std::ptr::copy_nonoverlapping((target as u64).to_ne_bytes().as_ptr(), at.add(6), 8);
        }
    }

    fn patch_rel32_jmp(target: usize, stub: usize) -> Result<(), HookError> {
        let page = target & !(PAGE_SIZE - 1);
        let original = prot_of(target).unwrap_or(libc::PROT_READ | libc::PROT_EXEC);
        mprotect_rw(page, PAGE_SIZE)?;
        unsafe {
            let at = target as *mut u8;
            *at = 0xE9;
            let rel = (stub as isize).wrapping_sub((target as isize) + 5);
            write_i32(at.add(1), rel as i32);
        }
        // Restore the original protection (W^X): never leave .text writable.
        if unsafe { libc::mprotect(page as *mut c_void, PAGE_SIZE, original) } != 0 {
            let _ = unsafe {
                libc::mprotect(
                    page as *mut c_void,
                    PAGE_SIZE,
                    libc::PROT_READ | libc::PROT_EXEC,
                )
            };
        }
        Ok(())
    }

    fn unpatch(target: usize) -> Result<(), HookError> {
        let page = target & !(PAGE_SIZE - 1);
        let original = prot_of(target).unwrap_or(libc::PROT_READ | libc::PROT_EXEC);
        mprotect_rw(page, PAGE_SIZE)?;
        unsafe { std::ptr::copy_nonoverlapping(PROLOGUE.as_ptr(), target as *mut u8, 5) };
        if unsafe { libc::mprotect(page as *mut c_void, PAGE_SIZE, original) } != 0 {
            let _ = unsafe {
                libc::mprotect(
                    page as *mut c_void,
                    PAGE_SIZE,
                    libc::PROT_READ | libc::PROT_EXEC,
                )
            };
        }
        Ok(())
    }

    /// Parses /proc/self/maps to recover the protection bits of the page that
    /// owns `addr`, so the hook can restore (not widen) the original mapping.
    fn prot_of(addr: usize) -> Option<libc::c_int> {
        let maps = std::fs::read_to_string("/proc/self/maps").ok()?;
        for line in maps.lines() {
            let Some((range, rest)) = line.split_once(char::is_whitespace) else {
                continue;
            };
            let Some((start_s, end_s)) = range.split_once('-') else {
                continue;
            };
            let (Ok(start), Ok(end)) = (
                usize::from_str_radix(start_s, 16),
                usize::from_str_radix(end_s, 16),
            ) else {
                continue;
            };
            if addr < start || addr >= end {
                continue;
            }
            let perms = rest.split_whitespace().next().unwrap_or("r-xp");
            let mut prot = 0;
            if perms.contains('r') {
                prot |= libc::PROT_READ;
            }
            if perms.contains('w') {
                prot |= libc::PROT_WRITE;
            }
            if perms.contains('x') {
                prot |= libc::PROT_EXEC;
            }
            return Some(prot);
        }
        None
    }

    /// Allocates a private page within `jmp rel32` range of `target` by hunting
    /// /proc/self/maps for a gap and mapping it with MAP_FIXED_NOREPLACE.
    fn alloc_near(target: usize, size: usize) -> Result<usize, HookError> {
        let lo = target
            .checked_sub(NEAR_LIMIT as usize)
            .unwrap_or(PAGE_SIZE)
            .max(PAGE_SIZE);
        let hi = target
            .checked_add(NEAR_LIMIT as usize)
            .unwrap_or(usize::MAX)
            .min(0x7fff_ffff_ffff);
        let maps = std::fs::read_to_string("/proc/self/maps")
            .map_err(|error| HookError::Create(format!("read /proc/self/maps: {error}")))?;
        let mut prev_end: usize = 0;
        for line in maps.lines() {
            let Some((start_s, end_s)) = line
                .split_once(char::is_whitespace)
                .and_then(|(r, _)| r.split_once('-'))
            else {
                continue;
            };
            let (Ok(start), Ok(end)) = (
                usize::from_str_radix(start_s, 16),
                usize::from_str_radix(end_s, 16),
            ) else {
                continue;
            };
            if prev_end < start {
                let gap_lo = prev_end.max(lo);
                let gap_hi = start.min(hi);
                if gap_hi > gap_lo && gap_hi - gap_lo >= size {
                    let mut candidate = (gap_lo + PAGE_SIZE - 1) & !(PAGE_SIZE - 1);
                    while candidate + size <= gap_hi {
                        let mapped = unsafe {
                            libc::mmap(
                                candidate as *mut c_void,
                                size,
                                libc::PROT_READ | libc::PROT_WRITE,
                                libc::MAP_PRIVATE | libc::MAP_ANONYMOUS | MAP_FIXED_NOREPLACE,
                                -1,
                                0,
                            )
                        };
                        if mapped == candidate as *mut c_void {
                            return Ok(candidate);
                        }
                        if mapped != libc::MAP_FAILED {
                            unsafe { libc::munmap(mapped, size) };
                        }
                        candidate += PAGE_SIZE;
                    }
                }
            }
            prev_end = prev_end.max(end);
        }
        Err(HookError::Create(
            "no in-range memory gap for QQNT hook stub".into(),
        ))
    }

    /// QQNT internal libc++ `basic_string` payload slot for a string of
    /// `expected_length` bytes (SSO tag at +0, long layout when LSB is set).
    unsafe fn qq_string_payload(value: *mut u8, expected_length: usize) -> Option<*mut u8> {
        if value.is_null() {
            return None;
        }
        let tag = unsafe { *value };
        if tag & 1 == 0 {
            ((tag as usize >> 1) == expected_length).then(|| unsafe { value.add(1) })
        } else {
            let length = unsafe { value.add(8).cast::<usize>().read_unaligned() };
            let data = unsafe { value.add(16).cast::<*mut u8>().read_unaligned() };
            (length == expected_length && (!data.is_null() || length == 0)).then_some(data)
        }
    }

    unsafe fn qq_string_bytes(value: *const u8) -> Option<(*const u8, usize)> {
        if value.is_null() {
            return None;
        }
        let tag = unsafe { *value };
        if tag & 1 == 0 {
            Some((unsafe { value.add(1) }, tag as usize >> 1))
        } else {
            let length = unsafe { value.add(8).cast::<usize>().read_unaligned() };
            let data = unsafe { value.add(16).cast::<*const u8>().read_unaligned() };
            (!data.is_null() || length == 0).then_some((data, length))
        }
    }

    unsafe extern "C" fn shim_converter(dest: *mut u8, env: napi_env, value: napi_value) {
        let trampoline = ORIGINAL_CONVERTER.load(Ordering::Acquire);
        if trampoline == 0 {
            return;
        }
        let original: Converter = unsafe { std::mem::transmute(trampoline) };

        let mut is_buffer = false;
        if unsafe { napi_is_buffer(env, value, &mut is_buffer) } != 0 || !is_buffer {
            return unsafe { original(dest, env, value) };
        }

        let mut data: *mut c_void = std::ptr::null_mut();
        let mut length = 0usize;
        if unsafe { napi_get_buffer_info(env, value, &mut data, &mut length) } != 0
            || length > (isize::MAX as usize)
        {
            return unsafe { original(dest, env, value) };
        }

        // Let QQNT allocate its string for a same-length ASCII placeholder,
        // then overwrite the payload with the Buffer bytes. This keeps the
        // allocation/destruction on QQNT's own ABI.
        let placeholder = vec![b'A'; length];
        let mut placeholder_value: napi_value = std::ptr::null_mut();
        if unsafe {
            napi_create_string_utf8(
                env,
                placeholder.as_ptr().cast(),
                length as isize,
                &mut placeholder_value,
            )
        } != 0
            || placeholder_value.is_null()
        {
            return unsafe { original(dest, env, value) };
        }

        unsafe { original(dest, env, placeholder_value) };
        if length != 0
            && let Some(output) = unsafe { qq_string_payload(dest, length) }
        {
            unsafe { std::ptr::copy_nonoverlapping(data.cast::<u8>(), output, length) };
        }
    }

    unsafe extern "C" fn shim_resolver(task: *mut u8) {
        if task.is_null() {
            return;
        }
        let state = unsafe { task.add(0x10).cast::<*mut u8>().read_unaligned() };
        if state.is_null() {
            return;
        }
        let env = unsafe { state.add(0x18).cast::<napi_env>().read_unaligned() };
        let deferred = unsafe { state.add(0x20).cast::<napi_deferred>().read_unaligned() };
        if env.is_null() || deferred.is_null() {
            return;
        }

        let result_code = unsafe { task.add(0x18).cast::<i32>().read_unaligned() };
        let Some((error_data, error_length)) = (unsafe { qq_string_bytes(task.add(0x20)) }) else {
            return;
        };
        let Some((response_data, response_length)) = (unsafe { qq_string_bytes(task.add(0x38)) })
        else {
            return;
        };
        const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
        const MAX_ERROR_BYTES: usize = 1024 * 1024;
        if response_length > MAX_RESPONSE_BYTES || error_length > MAX_ERROR_BYTES {
            return;
        }

        let mut scope: napi_handle_scope = std::ptr::null_mut();
        if unsafe { napi_open_handle_scope(env, &mut scope) } != 0 || scope.is_null() {
            return;
        }
        let converted = unsafe {
            convert_response(
                env,
                deferred,
                result_code,
                error_data,
                error_length,
                response_data,
                response_length,
            )
        };
        let _ = unsafe { napi_close_handle_scope(env, scope) };
        if converted {
            unsafe {
                state
                    .add(0x20)
                    .cast::<napi_deferred>()
                    .write_unaligned(std::ptr::null_mut())
            };
        }
    }

    #[allow(clippy::too_many_arguments)]
    unsafe fn convert_response(
        env: napi_env,
        deferred: napi_deferred,
        result_code: i32,
        error_data: *const u8,
        error_length: usize,
        response_data: *const u8,
        response_length: usize,
    ) -> bool {
        let mut object: napi_value = std::ptr::null_mut();
        let mut result_value: napi_value = std::ptr::null_mut();
        let mut error_value: napi_value = std::ptr::null_mut();
        let mut response_value: napi_value = std::ptr::null_mut();
        if unsafe { napi_create_object(env, &mut object) } != 0
            || unsafe { napi_create_int32(env, result_code, &mut result_value) } != 0
            || unsafe { napi_set_named_property(env, object, c"result".as_ptr(), result_value) }
                != 0
            || unsafe {
                napi_create_string_utf8(
                    env,
                    error_data.cast(),
                    error_length as isize,
                    &mut error_value,
                )
            } != 0
            || unsafe { napi_set_named_property(env, object, c"errMsg".as_ptr(), error_value) } != 0
            || unsafe {
                napi_create_buffer_copy(
                    env,
                    response_length,
                    response_data.cast(),
                    std::ptr::null_mut(),
                    &mut response_value,
                )
            } != 0
            || unsafe {
                napi_set_named_property(env, object, c"rspbuffer".as_ptr(), response_value)
            } != 0
            || unsafe { napi_resolve_deferred(env, deferred, object) } != 0
        {
            return false;
        }
        true
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn resolves_small_and_heap_qq_strings() {
            let mut small = [0u8; 24];
            small[0] = 10;
            assert_eq!(
                unsafe { qq_string_payload(small.as_mut_ptr(), 5) },
                Some(unsafe { small.as_mut_ptr().add(1) }),
            );
            assert!(unsafe { qq_string_payload(small.as_mut_ptr(), 4) }.is_none());

            let mut heap_data = [0u8; 32];
            let mut heap = [0u8; 24];
            heap[0] = 1;
            heap[8..16].copy_from_slice(&32usize.to_ne_bytes());
            heap[16..24].copy_from_slice(&(heap_data.as_mut_ptr() as usize).to_ne_bytes());
            assert_eq!(
                unsafe { qq_string_payload(heap.as_mut_ptr(), 32) },
                Some(heap_data.as_mut_ptr()),
            );
            assert_eq!(
                unsafe { qq_string_bytes(small.as_ptr()) },
                Some((unsafe { small.as_ptr().add(1) }, 5)),
            );
            assert_eq!(
                unsafe { qq_string_bytes(heap.as_ptr()) },
                Some((heap_data.as_ptr(), 32)),
            );
        }

        #[test]
        fn abs_jmp_encoding_targets_the_following_pointer() {
            let mut buf = [0u8; 14];
            write_abs_jmp(buf.as_mut_ptr(), 0xdead_beef);
            assert_eq!(&buf[0..6], &[0xff, 0x25, 0, 0, 0, 0]);
            assert_eq!(
                u64::from_ne_bytes(buf[6..14].try_into().unwrap()),
                0xdead_beef
            );
        }

        #[test]
        fn parses_msf_receive_record_layout() {
            let payload = b"abc123".to_vec();
            let mut buffer = vec![payload.as_ptr() as usize, unsafe {
                payload.as_ptr().add(payload.len()) as usize
            }];
            let mut record = vec![0u8; 128];
            let uin = b"1715311957";
            record[0] = (uin.len() * 2) as u8;
            record[1..1 + uin.len()].copy_from_slice(uin);
            record[24..28].copy_from_slice(&42u32.to_ne_bytes());
            let command = b"trpc.msg.olpush.OlPushService.MsgPush".to_vec();
            record[32] = 1;
            record[40..48].copy_from_slice(&command.len().to_ne_bytes());
            record[48..56].copy_from_slice(&(command.as_ptr() as usize).to_ne_bytes());
            record[56..64].copy_from_slice(&(buffer.as_mut_ptr() as usize).to_ne_bytes());

            let packet = unsafe { parse_receive_packet(record.as_mut_ptr()) }.expect("packet");
            assert_eq!(packet.uin, "1715311957");
            assert_eq!(packet.command, "trpc.msg.olpush.OlPushService.MsgPush");
            assert_eq!(packet.sequence, 42);
            assert_eq!(packet.payload, payload);
        }

        #[test]
        fn rejects_unreadable_receive_buffer_without_faulting() {
            let mut record = [0u8; 64];
            record[0] = 0;
            record[32] = 0;
            record[56..64].copy_from_slice(&1usize.to_ne_bytes());
            assert!(unsafe { parse_receive_packet(record.as_mut_ptr()) }.is_none());
        }

        #[test]
        fn parses_wrapped_receive_record_layout() {
            let payload = b"wrapped".to_vec();
            let mut buffer = vec![payload.as_ptr() as usize, unsafe {
                payload.as_ptr().add(payload.len()) as usize
            }];
            let command = b"trpc.msg.olpush.OlPushService.MsgPush".to_vec();
            let mut inner = vec![0u8; 0x48];
            inner[0x20] = 1;
            inner[0x28..0x30].copy_from_slice(&command.len().to_ne_bytes());
            inner[0x30..0x38].copy_from_slice(&(command.as_ptr() as usize).to_ne_bytes());
            inner[0x38..0x40].copy_from_slice(&(buffer.as_mut_ptr() as usize).to_ne_bytes());
            let mut record = vec![0u8; 64];
            record[0..8].copy_from_slice(&(inner.as_mut_ptr() as usize).to_ne_bytes());

            let packet = unsafe { parse_receive_packet(record.as_mut_ptr()) }.expect("packet");
            assert_eq!(packet.uin, "");
            assert_eq!(packet.command, "trpc.msg.olpush.OlPushService.MsgPush");
            assert_eq!(packet.payload, payload);
        }

        // End-to-end mechanism check without QQNT: synthesize an executable
        // page whose function has the validated prologue, hook it through a
        // test shim, and confirm the shim runs and the trampoline reaches the
        // original body.
        static TEST_SHIM_RAN: AtomicUsize = AtomicUsize::new(0);

        unsafe extern "C" fn test_shim(arg: *mut u8, env: napi_env, value: napi_value) {
            TEST_SHIM_RAN.store(1, Ordering::SeqCst);
            let trampoline = ORIGINAL_CONVERTER.load(Ordering::Acquire);
            if trampoline != 0 {
                let original: Converter = unsafe { std::mem::transmute(trampoline) };
                unsafe { original(arg, env, value) };
            }
        }

        #[test]
        fn trampoline_reaches_the_original_body() {
            // 41 57 41 56 53            push r15 ; push r14 ; push rbx
            // B8 42 00 00 00            mov eax, 0x42
            // 5B                        pop rbx
            // 41 5E                     pop r14
            // 41 5F                     pop r15
            // C3                        ret
            let mut body = [
                0x41u8, 0x57, 0x41, 0x56, 0x53, 0xB8, 0x42, 0x00, 0x00, 0x00, 0x5B, 0x41, 0x5E,
                0x41, 0x5F, 0xC3,
            ];
            let target = unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    PAGE_SIZE,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                    -1,
                    0,
                )
            };
            assert_ne!(target, libc::MAP_FAILED);
            unsafe { std::ptr::copy_nonoverlapping(body.as_ptr(), target as *mut u8, body.len()) };
            assert_eq!(
                unsafe { libc::mprotect(target, PAGE_SIZE, libc::PROT_READ | libc::PROT_EXEC) },
                0
            );

            let target_addr = target as usize;
            assert!(verify_prologue(target_addr).is_ok());

            let near = alloc_near(target_addr, PAGE_SIZE).expect("near page");
            let page = near as *mut u8;
            unsafe {
                std::ptr::copy_nonoverlapping(target as *const u8, page.add(OFF_CONV_TRAMP), 5);
                let jmp_at = page.add(OFF_CONV_TRAMP + 5);
                *jmp_at = 0xE9;
                let rel = (target_addr + 5) as isize - (near + OFF_CONV_TRAMP + 10) as isize;
                write_i32(jmp_at.add(1), rel as i32);
                write_abs_jmp(page.add(OFF_CONV_STUB), test_shim as *const () as usize);
            }
            assert!(mprotect_rx(near, PAGE_SIZE).is_ok());
            ORIGINAL_CONVERTER.store(near + OFF_CONV_TRAMP, Ordering::Release);

            assert!(patch_rel32_jmp(target_addr, near + OFF_CONV_STUB).is_ok());
            TEST_SHIM_RAN.store(0, Ordering::SeqCst);

            let func: unsafe extern "C" fn(*mut u8, napi_env, napi_value) -> usize =
                unsafe { std::mem::transmute(target_addr) };
            let got = unsafe {
                func(
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            assert_eq!(got, 0x42, "trampoline must reach the original body");
            assert_eq!(
                TEST_SHIM_RAN.load(Ordering::SeqCst),
                1,
                "shim must run before the original"
            );

            let _ = unpatch(target_addr);
            ORIGINAL_CONVERTER.store(0, Ordering::Release);
            unsafe {
                libc::munmap(target, PAGE_SIZE);
                libc::munmap(near as *mut c_void, PAGE_SIZE);
            }
            let _ = &mut body;
        }
    }
}

#[cfg(windows)]
pub use windows::install;

#[cfg(target_os = "linux")]
pub use linux::{drain_receive_packets, install, install_receive};

#[cfg(not(target_os = "linux"))]
pub fn drain_receive_packets() -> Vec<ReceivePacket> {
    Vec::new()
}

#[cfg(not(target_os = "linux"))]
pub fn install_receive(_probe: &crate::elf::PacketBindingProbe) -> Result<u64, HookError> {
    Err(HookError::Create(
        "native receive hook is not implemented on this platform".into(),
    ))
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn install(_probe: &crate::elf::PacketBindingProbe) -> Result<(), HookError> {
    Err(HookError::Unsupported)
}
