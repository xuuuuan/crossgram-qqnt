use crate::locator::LocatedBinding;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum HookError {
    #[cfg(not(windows))]
    #[error("QQNT Buffer conversion hook is only supported on Windows")]
    Unsupported,
    #[error("QQNT packet hook was already installed at a different address")]
    DifferentTarget,
    #[error("failed to create QQNT packet hook: {0}")]
    Create(String),
    #[error("failed to enable QQNT packet hook: {0}")]
    Enable(String),
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

#[cfg(windows)]
pub use windows::install;

#[cfg(not(windows))]
pub fn install(_location: &LocatedBinding) -> Result<(), HookError> {
    Err(HookError::Unsupported)
}
