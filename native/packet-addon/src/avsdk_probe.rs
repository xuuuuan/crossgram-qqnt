/// Fixed, identifier-free result of the temporary loader-identity probe.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct AvsdkLoaderProbeSnapshot {
    pub prepared: bool,
    pub observed: bool,
    pub unique: bool,
    pub same_object: bool,
    pub same_namespace: bool,
    pub build_match: bool,
    pub flags_compatible: bool,
    pub observation_count: u32,
}

#[cfg(not(all(target_os = "linux", feature = "avsdk-loader-probe")))]
pub(crate) fn snapshot() -> AvsdkLoaderProbeSnapshot {
    AvsdkLoaderProbeSnapshot::default()
}

#[cfg(not(all(target_os = "linux", feature = "avsdk-loader-probe")))]
pub(crate) fn register_napi_cleanup(_: napi::sys::napi_env) {}

#[cfg(all(target_os = "linux", feature = "avsdk-loader-probe"))]
mod enabled {
    use super::AvsdkLoaderProbeSnapshot;
    use crate::{elf::ElfImage, locator};
    use std::{
        ffi::{CStr, CString, OsStr, c_char, c_int, c_void},
        fs::File,
        io::Read,
        mem::MaybeUninit,
        os::{
            fd::{FromRawFd, RawFd},
            unix::ffi::OsStrExt,
        },
        path::{Component, Path},
        sync::{
            Mutex, OnceLock,
            atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        },
    };

    // This feature is deliberately fixed to one audited QQ installation. It
    // has no runtime enable path, and normal builds compile none of this code.
    const FIXED_AVSDK_PATH: &str = "/opt/QQ/resources/app/avsdk/libAVSDKPlugin.so";
    const FIXED_BUILD_ID: [u8; 8] = [0xd6, 0x15, 0x9b, 0x67, 0x01, 0xb4, 0x66, 0x83];
    const FIXED_SHA256: [u8; 32] = [
        0xac, 0x5e, 0xab, 0xbe, 0x96, 0xf1, 0xd0, 0x1c, 0xb1, 0x84, 0x7a, 0xfa, 0x8a, 0x98, 0x21,
        0x13, 0x65, 0xe8, 0xd3, 0x7f, 0xc6, 0x99, 0xf1, 0xc6, 0x69, 0xb6, 0xfd, 0x34, 0x4a, 0x4b,
        0x13, 0xdb,
    ];
    const DESTRUCTOR_RVA: u64 = 0x53_f840;
    const DESTRUCTOR_FINGERPRINT: [u8; 16] = [
        0x41, 0x57, 0x41, 0x56, 0x53, 0x48, 0x83, 0xec, 0x20, 0x49, 0x89, 0xfe, 0x48, 0x8d, 0x05,
        0x45,
    ];
    const RTLD_DI_LMID: c_int = 1;
    const RTLD_DI_LINKMAP: c_int = 2;
    const PT_LOAD: u32 = 1;
    const PF_W: u32 = 2;
    const DT_NULL: i64 = 0;
    const DT_STRTAB: i64 = 5;
    const DT_SYMTAB: i64 = 6;
    const DT_RELA: i64 = 7;
    const DT_JMPREL: i64 = 23;
    const DT_PLTRELSZ: i64 = 2;
    const DT_PLTREL: i64 = 20;
    const MAX_PROGRAM_HEADERS: usize = 128;
    const MAX_DYNAMIC_ENTRIES: usize = 4096;
    const MAX_RELOCATIONS: usize = 1_000_000;
    const INSTALL_IDLE: u8 = 0;
    const INSTALLING: u8 = 1;
    const INSTALLED: u8 = 2;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct ObjectKey {
        device: u64,
        inode: u64,
    }

    #[derive(Clone, Copy)]
    struct HookRecord {
        _slot: usize,
        _original_slot: usize,
        _external_dlopen: usize,
        _protection: c_int,
    }

    #[derive(Default)]
    struct ProbeState {
        hook: Option<HookRecord>,
        snapshot: AvsdkLoaderProbeSnapshot,
    }

    #[repr(C)]
    struct LinkMap {
        address: usize,
        name: *const c_char,
        dynamic: *mut c_void,
        next: *mut LinkMap,
        previous: *mut LinkMap,
    }

    struct HandleIdentity {
        object: ObjectKey,
        base: usize,
        lmid: libc::Lmid_t,
        build_match: bool,
        mapped_fingerprint_match: bool,
    }

    struct OwnedRawFd(RawFd);

    impl Drop for OwnedRawFd {
        fn drop(&mut self) {
            unsafe { libc::close(self.0) };
        }
    }

    impl OwnedRawFd {
        fn into_file(self) -> File {
            let fd = self.0;
            std::mem::forget(self);
            unsafe { File::from_raw_fd(fd) }
        }
    }

    struct TrustedFile {
        file: File,
        object: ObjectKey,
    }

    trait GotSlot {
        fn protection(&mut self) -> Option<c_int>;
        fn set_protection(&mut self, protection: c_int) -> bool;
        fn read(&self) -> usize;
        fn write(&mut self, value: usize) -> bool;
        fn address(&self) -> usize;
    }

    struct NativeGotSlot {
        slot: usize,
        page: usize,
        page_size: usize,
    }

    impl GotSlot for NativeGotSlot {
        fn protection(&mut self) -> Option<c_int> {
            protection_at(self.slot)
        }

        fn set_protection(&mut self, protection: c_int) -> bool {
            unsafe { libc::mprotect(self.page as *mut c_void, self.page_size, protection) == 0 }
        }

        fn read(&self) -> usize {
            unsafe { (self.slot as *const usize).read_volatile() }
        }

        fn write(&mut self, value: usize) -> bool {
            unsafe { (self.slot as *mut usize).write_volatile(value) };
            true
        }

        fn address(&self) -> usize {
            self.slot
        }
    }

    type Dlopen = unsafe extern "C" fn(*const c_char, c_int) -> *mut c_void;

    static STATE: OnceLock<Mutex<ProbeState>> = OnceLock::new();
    static INSTALL_STATE: AtomicU8 = AtomicU8::new(INSTALL_IDLE);
    static ORIGINAL_DLOPEN: AtomicUsize = AtomicUsize::new(0);
    static OBSERVATIONS_ENABLED: AtomicBool = AtomicBool::new(true);
    static CLEANUP_REGISTERED: AtomicBool = AtomicBool::new(false);

    fn state() -> &'static Mutex<ProbeState> {
        STATE.get_or_init(|| Mutex::new(ProbeState::default()))
    }

    pub(super) fn register_napi_cleanup(env: napi::sys::napi_env) {
        if CLEANUP_REGISTERED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        if unsafe { napi::sys::napi_add_env_cleanup_hook(env, Some(cleanup), std::ptr::null_mut()) }
            != 0
        {
            CLEANUP_REGISTERED.store(false, Ordering::Release);
        }
    }

    unsafe extern "C" fn cleanup(_: *mut c_void) {
        // Node retains native addons for process lifetime. Do not unpatch live
        // wrapper code during cleanup: the permanent shim still forwards via
        // ORIGINAL_DLOPEN, but no later call can mutate diagnostic state.
        OBSERVATIONS_ENABLED.store(false, Ordering::Release);
    }

    pub(super) fn snapshot() -> AvsdkLoaderProbeSnapshot {
        let Ok(mut state) = state().lock() else {
            return AvsdkLoaderProbeSnapshot::default();
        };
        if OBSERVATIONS_ENABLED.load(Ordering::Acquire) {
            ensure_wrapper_dlopen_shim(&mut state);
        }
        state.snapshot
    }

    fn ensure_wrapper_dlopen_shim(state: &mut ProbeState) {
        if state.hook.is_some() || !OBSERVATIONS_ENABLED.load(Ordering::Acquire) {
            return;
        }
        if INSTALL_STATE
            .compare_exchange(
                INSTALL_IDLE,
                INSTALLING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            return;
        }

        let installed = (|| {
            let wrapper = locator::probe_packet_binding().ok()?;
            let mut image = File::open(&wrapper.module_path).ok()?;
            let mut bytes = Vec::new();
            image.read_to_end(&mut bytes).ok()?;
            let got_rva = find_dlopen_relocation(&bytes);
            bytes.fill(0);
            let external_dlopen = resolve_external_dlopen(wrapper.module_base)?;
            let slot = wrapper.module_base.checked_add(got_rva? as usize)?;
            let mut slot = native_got_slot(slot)?;
            install_got_transaction(
                &mut slot,
                external_dlopen,
                dlopen_shim as *const () as usize,
            )
        })();

        match installed {
            Some(record) => {
                state.hook = Some(record);
                state.snapshot.prepared = true;
                INSTALL_STATE.store(INSTALLED, Ordering::Release);
            }
            None => {
                // A failed installation never poisons future safe-boundary
                // attempts. Transaction rollback has already restored slot and
                // protection before this state becomes retryable.
                INSTALL_STATE.store(INSTALL_IDLE, Ordering::Release);
            }
        }
    }

    /// Resolve the real external implementation before replacing the PLT slot.
    /// A lazy PLT continuation is never used as the shim's forwarding target.
    fn resolve_external_dlopen(wrapper_base: usize) -> Option<usize> {
        let target = unsafe { libc::dlsym(libc::RTLD_NEXT, c"dlopen".as_ptr()) } as usize;
        verify_external_dlopen(
            target,
            wrapper_base,
            executable_mapping(target),
            address_in_wrapper(wrapper_base, target)?,
        )
    }

    fn verify_external_dlopen(
        target: usize,
        wrapper_base: usize,
        executable: bool,
        in_wrapper: bool,
    ) -> Option<usize> {
        (target != 0
            && target != dlopen_shim as *const () as usize
            && wrapper_base != 0
            && executable
            && !in_wrapper)
            .then_some(target)
    }

    fn address_in_wrapper(wrapper_base: usize, address: usize) -> Option<bool> {
        struct Query {
            base: usize,
            address: usize,
            found: bool,
            contains: bool,
        }
        unsafe extern "C" fn visit(
            info: *mut libc::dl_phdr_info,
            _: libc::size_t,
            data: *mut c_void,
        ) -> c_int {
            let query = unsafe { &mut *data.cast::<Query>() };
            let info = unsafe { &*info };
            if info.dlpi_addr as usize != query.base || info.dlpi_phdr.is_null() {
                return 0;
            }
            query.found = true;
            for index in 0..usize::from(info.dlpi_phnum) {
                let header = unsafe { &*info.dlpi_phdr.add(index) };
                if header.p_type != PT_LOAD {
                    continue;
                }
                let Some(start) = query.base.checked_add(header.p_vaddr as usize) else {
                    continue;
                };
                let Some(end) = start.checked_add(header.p_memsz as usize) else {
                    continue;
                };
                if query.address >= start && query.address < end {
                    query.contains = true;
                }
            }
            1
        }

        let mut query = Query {
            base: wrapper_base,
            address,
            found: false,
            contains: false,
        };
        unsafe {
            libc::dl_iterate_phdr(Some(visit), (&mut query as *mut Query).cast::<c_void>());
        }
        query.found.then_some(query.contains)
    }

    fn native_got_slot(slot: usize) -> Option<NativeGotSlot> {
        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if page_size <= 0 {
            return None;
        }
        let page_size = page_size as usize;
        Some(NativeGotSlot {
            slot,
            page: slot & !(page_size - 1),
            page_size,
        })
    }

    fn install_got_transaction<S: GotSlot + ?Sized>(
        slot: &mut S,
        external_dlopen: usize,
        replacement: usize,
    ) -> Option<HookRecord> {
        let original_slot = slot.read();
        if original_slot == 0 || external_dlopen == 0 {
            return None;
        }
        let protection = slot.protection()?;
        let record = HookRecord {
            _slot: slot.address(),
            _original_slot: original_slot,
            _external_dlopen: external_dlopen,
            _protection: protection,
        };
        if !slot.set_protection(libc::PROT_READ | libc::PROT_WRITE) {
            return None;
        }

        // The wrapper.node process.dlopen-return boundary is the established
        // no-execution patch boundary. Publish before the slot is rewritten so
        // the permanent shim can always forward if that boundary changes.
        ORIGINAL_DLOPEN.store(external_dlopen, Ordering::Release);
        if !slot.write(replacement) || !slot.set_protection(protection) {
            let _ = slot.write(original_slot);
            let _ = slot.set_protection(protection);
            ORIGINAL_DLOPEN.store(0, Ordering::Release);
            return None;
        }
        Some(record)
    }

    unsafe extern "C" fn dlopen_shim(path: *const c_char, flags: c_int) -> *mut c_void {
        let original = ORIGINAL_DLOPEN.load(Ordering::Acquire);
        if original == 0 {
            return std::ptr::null_mut();
        }
        let original: Dlopen = unsafe { std::mem::transmute(original) };
        // Always forward first. Identity checks happen only against the exact
        // returned host handle, so this probe never initiates AVSDK loading.
        let handle = unsafe { original(path, flags) };
        if !handle.is_null() && OBSERVATIONS_ENABLED.load(Ordering::Acquire) {
            observe_host_handle(handle, flags);
        }
        handle
    }

    fn observe_host_handle(handle: *mut c_void, flags: c_int) {
        let Ok(mut state) = state().lock() else {
            return;
        };
        if !OBSERVATIONS_ENABLED.load(Ordering::Acquire)
            || state.snapshot.observation_count >= 2
            || state.hook.is_none()
        {
            return;
        }
        let Some(actual) = inspect_handle(handle) else {
            return;
        };
        let Some(trusted) = trusted_noload_handle() else {
            return;
        };
        let observation = Observation {
            unique_mapping: mapping_count(actual.object) == 1,
            same_object: actual.object == trusted.object && actual.base == trusted.base,
            same_namespace: actual.lmid == trusted.lmid,
            build_match: actual.build_match
                && trusted.build_match
                && actual.mapped_fingerprint_match
                && trusted.mapped_fingerprint_match,
            flags_compatible: compatible_flags(flags),
        };
        record_observation(&mut state, observation);
    }

    fn trusted_noload_handle() -> Option<HandleIdentity> {
        let trusted = open_trusted(Path::new(FIXED_AVSDK_PATH))?;
        if !validate_file(&trusted.file) {
            return None;
        }
        let path = CString::new(FIXED_AVSDK_PATH).ok()?;
        // RTLD_NOLOAD only obtains a reference to an already host-loaded DSO;
        // it cannot run constructors or cause AVSDK to load.
        let handle = unsafe {
            libc::dlopen(
                path.as_ptr(),
                libc::RTLD_NOLOAD | libc::RTLD_NOW | libc::RTLD_LOCAL,
            )
        };
        if handle.is_null() {
            return None;
        }
        let identity = inspect_handle(handle);
        unsafe { libc::dlclose(handle) };
        identity.filter(|identity| identity.object == trusted.object)
    }

    fn inspect_handle(handle: *mut c_void) -> Option<HandleIdentity> {
        let mut link_map: *mut LinkMap = std::ptr::null_mut();
        let mut lmid: libc::Lmid_t = 0;
        if unsafe {
            libc::dlinfo(
                handle,
                RTLD_DI_LINKMAP,
                (&mut link_map as *mut *mut LinkMap).cast::<c_void>(),
            )
        } != 0
            || link_map.is_null()
            || unsafe { (*link_map).name.is_null() }
            || unsafe {
                libc::dlinfo(
                    handle,
                    RTLD_DI_LMID,
                    (&mut lmid as *mut libc::Lmid_t).cast::<c_void>(),
                )
            } != 0
        {
            return None;
        }
        let path = unsafe { CStr::from_ptr((*link_map).name) };
        let trusted = open_trusted(Path::new(OsStr::from_bytes(path.to_bytes())))?;
        let base = unsafe { (*link_map).address };
        Some(HandleIdentity {
            object: trusted.object,
            base,
            lmid,
            build_match: validate_file(&trusted.file),
            mapped_fingerprint_match: mapped_fingerprint_matches(base),
        })
    }

    fn open_trusted(path: &Path) -> Option<TrustedFile> {
        if !path.is_absolute() {
            return None;
        }
        let components: Vec<&OsStr> = path
            .components()
            .map(|component| match component {
                Component::RootDir => Some(OsStr::new("")),
                Component::Normal(part) => Some(part),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?;
        if components.len() < 2 || components[0] != OsStr::new("") {
            return None;
        }

        let root = CString::new("/").ok()?;
        let mut current = OwnedRawFd(unsafe {
            libc::open(
                root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        });
        if current.0 < 0 || trusted_stat(current.0, true).is_none() {
            return None;
        }
        for (index, part) in components.iter().enumerate().skip(1) {
            let name = CString::new(part.as_bytes()).ok()?;
            let final_component = index + 1 == components.len();
            let flags = libc::O_RDONLY
                | libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | if final_component {
                    0
                } else {
                    libc::O_DIRECTORY
                };
            let next = OwnedRawFd(unsafe { libc::openat(current.0, name.as_ptr(), flags) });
            if next.0 < 0 {
                return None;
            }
            let key = trusted_stat(next.0, !final_component)?;
            if final_component {
                return Some(TrustedFile {
                    file: next.into_file(),
                    object: key,
                });
            }
            current = next;
        }
        None
    }

    fn trusted_stat(fd: RawFd, directory: bool) -> Option<ObjectKey> {
        let mut stat = MaybeUninit::<libc::stat>::zeroed();
        if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
            return None;
        }
        let stat = unsafe { stat.assume_init() };
        let kind = stat.st_mode & libc::S_IFMT;
        if stat.st_uid != 0
            || stat.st_mode & 0o022 != 0
            || (directory && kind != libc::S_IFDIR)
            || (!directory && kind != libc::S_IFREG)
        {
            return None;
        }
        Some(ObjectKey {
            device: stat.st_dev,
            inode: stat.st_ino,
        })
    }

    fn validate_file(file: &File) -> bool {
        let mut reader = match file.try_clone() {
            Ok(reader) => reader,
            Err(_) => return false,
        };
        let mut bytes = Vec::new();
        if reader.read_to_end(&mut bytes).is_err() {
            return false;
        }
        let valid = validate_image(&bytes);
        bytes.fill(0);
        valid
    }

    fn validate_image(bytes: &[u8]) -> bool {
        let Ok(image) = ElfImage::parse(bytes) else {
            return false;
        };
        let mut build_id = match image.build_id() {
            Ok(build_id) => build_id,
            Err(_) => return false,
        };
        let valid = build_id == FIXED_BUILD_ID
            && image.sha256() == FIXED_SHA256
            && image
                .executable_bytes(DESTRUCTOR_RVA, DESTRUCTOR_FINGERPRINT.len() as u64)
                .is_ok_and(|fingerprint| fingerprint == DESTRUCTOR_FINGERPRINT);
        build_id.fill(0);
        valid
    }

    fn mapped_fingerprint_matches(base: usize) -> bool {
        let Some(address) = base.checked_add(DESTRUCTOR_RVA as usize) else {
            return false;
        };
        if !executable_mapping(address) {
            return false;
        }
        let mut fingerprint = unsafe { std::ptr::read_volatile(address as *const [u8; 16]) };
        let valid = fingerprint == DESTRUCTOR_FINGERPRINT;
        fingerprint.fill(0);
        valid
    }

    fn executable_mapping(address: usize) -> bool {
        let Ok(maps) = std::fs::read_to_string("/proc/self/maps") else {
            return false;
        };
        maps.lines().any(|line| {
            let Some((range, rest)) = line.split_once(char::is_whitespace) else {
                return false;
            };
            let Some((start, end)) = range.split_once('-') else {
                return false;
            };
            let (Ok(start), Ok(end)) = (
                usize::from_str_radix(start, 16),
                usize::from_str_radix(end, 16),
            ) else {
                return false;
            };
            address >= start
                && address < end
                && rest
                    .split_whitespace()
                    .next()
                    .is_some_and(|permissions| permissions.contains('x'))
        })
    }

    fn mapping_count(object: ObjectKey) -> u32 {
        struct Count {
            object: ObjectKey,
            count: u32,
        }
        unsafe extern "C" fn visit(
            info: *mut libc::dl_phdr_info,
            _: libc::size_t,
            data: *mut c_void,
        ) -> c_int {
            let count = unsafe { &mut *data.cast::<Count>() };
            let info = unsafe { &*info };
            if info.dlpi_name.is_null() {
                return 0;
            }
            let path = unsafe { CStr::from_ptr(info.dlpi_name) };
            let path = Path::new(OsStr::from_bytes(path.to_bytes()));
            if open_trusted(path).is_some_and(|candidate| candidate.object == count.object) {
                count.count = count.count.saturating_add(1).min(2);
            }
            0
        }
        let mut count = Count { object, count: 0 };
        unsafe {
            libc::dl_iterate_phdr(Some(visit), (&mut count as *mut Count).cast::<c_void>());
        }
        count.count
    }

    #[derive(Clone, Copy)]
    struct Observation {
        unique_mapping: bool,
        same_object: bool,
        same_namespace: bool,
        build_match: bool,
        flags_compatible: bool,
    }

    fn record_observation(state: &mut ProbeState, observation: Observation) {
        if state.snapshot.observation_count >= 2 {
            return;
        }
        if state.snapshot.observation_count == 0 {
            state.snapshot.observed = true;
            state.snapshot.unique = observation.unique_mapping;
            state.snapshot.same_object = observation.same_object;
            state.snapshot.same_namespace = observation.same_namespace;
            state.snapshot.build_match = observation.build_match;
            state.snapshot.flags_compatible = observation.flags_compatible;
            state.snapshot.observation_count = 1;
            return;
        }
        state.snapshot.observation_count = 2;
        state.snapshot.unique = false;
        state.snapshot.same_object &= observation.same_object;
        state.snapshot.same_namespace &= observation.same_namespace;
        state.snapshot.build_match &= observation.build_match;
        state.snapshot.flags_compatible &= observation.flags_compatible;
    }

    fn compatible_flags(flags: c_int) -> bool {
        let binding = flags & (libc::RTLD_LAZY | libc::RTLD_NOW);
        binding == libc::RTLD_NOW
            && flags & libc::RTLD_GLOBAL == 0
            && flags & libc::RTLD_DEEPBIND == 0
    }

    fn protection_at(address: usize) -> Option<c_int> {
        let maps = std::fs::read_to_string("/proc/self/maps").ok()?;
        for line in maps.lines() {
            let (range, rest) = line.split_once(char::is_whitespace)?;
            let (start, end) = range.split_once('-')?;
            let (Ok(start), Ok(end)) = (
                usize::from_str_radix(start, 16),
                usize::from_str_radix(end, 16),
            ) else {
                continue;
            };
            if address < start || address >= end {
                continue;
            }
            let permissions = rest.split_whitespace().next()?;
            let mut protection = 0;
            if permissions.contains('r') {
                protection |= libc::PROT_READ;
            }
            if permissions.contains('w') {
                protection |= libc::PROT_WRITE;
            }
            if permissions.contains('x') {
                protection |= libc::PROT_EXEC;
            }
            return Some(protection);
        }
        None
    }

    #[derive(Clone, Copy)]
    struct ProgramHeader {
        kind: u32,
        flags: u32,
        offset: u64,
        address: u64,
        file_size: u64,
    }

    fn find_dlopen_relocation(bytes: &[u8]) -> Option<u64> {
        if bytes.get(..4) != Some(b"\x7fELF") || bytes.get(4..7) != Some(&[2, 1, 1]) {
            return None;
        }
        let program_offset = read_u64(bytes, 32)? as usize;
        let program_count = read_u16(bytes, 56)? as usize;
        if program_count == 0 || program_count > MAX_PROGRAM_HEADERS || read_u16(bytes, 54)? != 56 {
            return None;
        }
        let mut headers = Vec::with_capacity(program_count);
        for index in 0..program_count {
            let offset = program_offset.checked_add(index.checked_mul(56)?)?;
            headers.push(ProgramHeader {
                kind: read_u32(bytes, offset)?,
                flags: read_u32(bytes, offset + 4)?,
                offset: read_u64(bytes, offset + 8)?,
                address: read_u64(bytes, offset + 16)?,
                file_size: read_u64(bytes, offset + 32)?,
            });
        }
        let dynamic = headers.iter().find(|header| header.kind == 2)?;
        let dynamic_start = dynamic.offset as usize;
        let dynamic_count = (dynamic.file_size / 16) as usize;
        if dynamic_count == 0 || dynamic_count > MAX_DYNAMIC_ENTRIES {
            return None;
        }
        let mut strtab = None;
        let mut symtab = None;
        let mut jmprel = None;
        let mut pltrelsz = None;
        let mut pltrel = None;
        for index in 0..dynamic_count {
            let offset = dynamic_start.checked_add(index.checked_mul(16)?)?;
            let tag = read_i64(bytes, offset)?;
            let value = read_u64(bytes, offset + 8)?;
            match tag {
                DT_NULL => break,
                DT_STRTAB => strtab = Some(value),
                DT_SYMTAB => symtab = Some(value),
                DT_JMPREL => jmprel = Some(value),
                DT_PLTRELSZ => pltrelsz = Some(value),
                DT_PLTREL => pltrel = Some(value),
                _ => {}
            }
        }
        if pltrel != Some(DT_RELA as u64) {
            return None;
        }
        let strtab = virtual_offset(&headers, strtab?)?;
        let symtab = virtual_offset(&headers, symtab?)?;
        let relocation_start = virtual_offset(&headers, jmprel?)?;
        let relocation_size = pltrelsz? as usize;
        if relocation_size == 0
            || !relocation_size.is_multiple_of(24)
            || relocation_size / 24 > MAX_RELOCATIONS
        {
            return None;
        }
        let mut slot = None;
        for index in 0..relocation_size / 24 {
            let offset = relocation_start.checked_add(index.checked_mul(24)?)?;
            let relocation = read_u64(bytes, offset)?;
            let symbol = (read_u64(bytes, offset + 8)? >> 32) as usize;
            let symbol_offset = symtab.checked_add(symbol.checked_mul(24)?)?;
            let name_offset = read_u32(bytes, symbol_offset)? as usize;
            if c_string_at(bytes, strtab.checked_add(name_offset)?) == Some(b"dlopen")
                && slot.replace(relocation).is_some()
            {
                return None;
            }
        }
        let slot = slot?;
        headers
            .iter()
            .any(|header| {
                header.kind == PT_LOAD
                    && header.flags & PF_W != 0
                    && slot >= header.address
                    && slot < header.address.checked_add(header.file_size).unwrap_or(0)
            })
            .then_some(slot)
    }

    fn virtual_offset(headers: &[ProgramHeader], address: u64) -> Option<usize> {
        headers.iter().find_map(|header| {
            (header.kind == PT_LOAD
                && address >= header.address
                && address < header.address.checked_add(header.file_size)?)
            .then(|| usize::try_from(header.offset.checked_add(address - header.address)?).ok())?
        })
    }

    fn c_string_at(bytes: &[u8], offset: usize) -> Option<&[u8]> {
        let end = bytes.get(offset..)?.iter().position(|byte| *byte == 0)?;
        bytes.get(offset..offset + end)
    }

    fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
        Some(u16::from_le_bytes(
            bytes.get(offset..offset + 2)?.try_into().ok()?,
        ))
    }
    fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
        Some(u32::from_le_bytes(
            bytes.get(offset..offset + 4)?.try_into().ok()?,
        ))
    }
    fn read_u64(bytes: &[u8], offset: usize) -> Option<u64> {
        Some(u64::from_le_bytes(
            bytes.get(offset..offset + 8)?.try_into().ok()?,
        ))
    }
    fn read_i64(bytes: &[u8], offset: usize) -> Option<i64> {
        Some(i64::from_le_bytes(
            bytes.get(offset..offset + 8)?.try_into().ok()?,
        ))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            sync::{Arc, Barrier},
            thread,
        };

        struct FakeSlot {
            value: usize,
            protection: c_int,
            fail_restore_once: bool,
            protection_calls: u8,
            writes: Vec<usize>,
        }

        impl GotSlot for FakeSlot {
            fn protection(&mut self) -> Option<c_int> {
                Some(self.protection)
            }
            fn set_protection(&mut self, protection: c_int) -> bool {
                self.protection_calls += 1;
                if self.protection_calls == 2 && self.fail_restore_once {
                    self.fail_restore_once = false;
                    return false;
                }
                self.protection = protection;
                true
            }
            fn read(&self) -> usize {
                self.value
            }
            fn write(&mut self, value: usize) -> bool {
                self.value = value;
                self.writes.push(value);
                true
            }
            fn address(&self) -> usize {
                0x700
            }
        }

        #[test]
        fn parses_a_realistic_single_dlopen_got_relocation_fixture() {
            let mut image = vec![0u8; 0x800];
            image[..4].copy_from_slice(b"\x7fELF");
            image[4..7].copy_from_slice(&[2, 1, 1]);
            image[32..40].copy_from_slice(&0x40u64.to_le_bytes());
            image[54..56].copy_from_slice(&56u16.to_le_bytes());
            image[56..58].copy_from_slice(&2u16.to_le_bytes());
            // PT_LOAD covers all synthetic dynamic, string, symbol and GOT data.
            image[0x40..0x44].copy_from_slice(&PT_LOAD.to_le_bytes());
            image[0x44..0x48].copy_from_slice(&PF_W.to_le_bytes());
            image[0x48..0x50].copy_from_slice(&0u64.to_le_bytes());
            image[0x50..0x58].copy_from_slice(&0u64.to_le_bytes());
            image[0x60..0x68].copy_from_slice(&0x800u64.to_le_bytes());
            // PT_DYNAMIC.
            image[0x78..0x7c].copy_from_slice(&2u32.to_le_bytes());
            image[0x80..0x88].copy_from_slice(&0x200u64.to_le_bytes());
            image[0x88..0x90].copy_from_slice(&0x200u64.to_le_bytes());
            image[0x98..0xa0].copy_from_slice(&0x80u64.to_le_bytes());
            for (index, (tag, value)) in [
                (DT_STRTAB, 0x400),
                (DT_SYMTAB, 0x500),
                (DT_JMPREL, 0x600),
                (DT_PLTRELSZ, 24),
                (DT_PLTREL, DT_RELA as u64),
                (DT_NULL, 0),
            ]
            .into_iter()
            .enumerate()
            {
                let at = 0x200 + index * 16;
                image[at..at + 8].copy_from_slice(&tag.to_le_bytes());
                image[at + 8..at + 16].copy_from_slice(&value.to_le_bytes());
            }
            image[0x400..0x407].copy_from_slice(b"dlopen\0");
            image[0x518..0x51c].copy_from_slice(&0u32.to_le_bytes());
            image[0x600..0x608].copy_from_slice(&0x700u64.to_le_bytes());
            image[0x608..0x610].copy_from_slice(&(1u64 << 32).to_le_bytes());
            assert_eq!(find_dlopen_relocation(&image), Some(0x700));
            image[0x618..0x620].copy_from_slice(&(1u64 << 32).to_le_bytes());
            image[0x610..0x618].copy_from_slice(&0x708u64.to_le_bytes());
            image[0x248..0x250].copy_from_slice(&48u64.to_le_bytes());
            assert_eq!(find_dlopen_relocation(&image), None);
        }

        #[test]
        fn protection_restore_failure_rolls_back_slot_and_page_protection() {
            let mut slot = FakeSlot {
                value: 0x1111,
                protection: libc::PROT_READ,
                fail_restore_once: true,
                protection_calls: 0,
                writes: Vec::new(),
            };
            assert!(install_got_transaction(&mut slot, 0x3333, 0x2222).is_none());
            assert_eq!(slot.value, 0x1111);
            assert_eq!(slot.protection, libc::PROT_READ);
            assert_eq!(slot.writes, vec![0x2222, 0x1111]);
        }

        #[test]
        fn unresolved_or_wrapper_local_dlopen_target_fails_closed() {
            let wrapper = 0x1000;
            // A lazy PLT continuation sits inside wrapper.node and must never
            // become the shim's forwarding target.
            assert_eq!(
                verify_external_dlopen(wrapper + 0x40, wrapper, true, true),
                None,
            );
            assert_eq!(verify_external_dlopen(0x4000, wrapper, false, false), None);
            assert_eq!(address_in_wrapper(usize::MAX, 0x4000), None);
            assert_eq!(
                verify_external_dlopen(0x4000, wrapper, true, false),
                Some(0x4000)
            );
        }

        #[test]
        fn resolved_external_target_survives_a_modeled_lazy_write_back() {
            let mut slot = FakeSlot {
                value: 0x1010,
                protection: libc::PROT_READ,
                fail_restore_once: false,
                protection_calls: 0,
                writes: Vec::new(),
            };
            let record = install_got_transaction(&mut slot, 0x4000, 0x5000).expect("install");
            assert_eq!(record._original_slot, 0x1010);
            assert_eq!(record._external_dlopen, 0x4000);
            assert_eq!(ORIGINAL_DLOPEN.load(Ordering::Acquire), 0x4000);
            assert_eq!(slot.value, 0x5000, "resolver cannot replace the shim slot");
            ORIGINAL_DLOPEN.store(0, Ordering::Release);
        }

        #[test]
        fn duplicate_and_concurrent_install_attempts_are_bounded() {
            INSTALL_STATE.store(INSTALL_IDLE, Ordering::Release);
            let barrier = Arc::new(Barrier::new(3));
            let workers: Vec<_> = (0..2)
                .map(|_| {
                    let barrier = Arc::clone(&barrier);
                    thread::spawn(move || {
                        barrier.wait();
                        INSTALL_STATE
                            .compare_exchange(
                                INSTALL_IDLE,
                                INSTALLING,
                                Ordering::AcqRel,
                                Ordering::Acquire,
                            )
                            .is_ok()
                    })
                })
                .collect();
            barrier.wait();
            let installed = workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .filter(|installed| *installed)
                .count();
            assert_eq!(installed, 1);
            INSTALL_STATE.store(INSTALL_IDLE, Ordering::Release);
        }

        #[test]
        fn cleanup_disables_observation_mutation_but_does_not_clear_forwarding() {
            ORIGINAL_DLOPEN.store(0x1234, Ordering::Release);
            let before = state().lock().unwrap().snapshot;
            unsafe { cleanup(std::ptr::null_mut()) };
            assert_eq!(ORIGINAL_DLOPEN.load(Ordering::Acquire), 0x1234);
            assert!(!OBSERVATIONS_ENABLED.load(Ordering::Acquire));
            assert_eq!(state().lock().unwrap().snapshot, before);
            OBSERVATIONS_ENABLED.store(true, Ordering::Release);
            ORIGINAL_DLOPEN.store(0, Ordering::Release);
        }

        #[test]
        fn duplicate_observation_is_bounded_and_not_unique() {
            let observation = Observation {
                unique_mapping: true,
                same_object: true,
                same_namespace: true,
                build_match: true,
                flags_compatible: true,
            };
            let mut state = ProbeState::default();
            record_observation(&mut state, observation);
            record_observation(&mut state, observation);
            record_observation(&mut state, observation);
            assert_eq!(state.snapshot.observation_count, 2);
            assert!(!state.snapshot.unique);
        }

        #[test]
        fn loader_flag_class_is_fail_closed() {
            assert!(compatible_flags(libc::RTLD_NOW));
            assert!(!compatible_flags(libc::RTLD_LAZY));
            assert!(!compatible_flags(libc::RTLD_NOW | libc::RTLD_GLOBAL));
        }
    }
}

#[cfg(all(target_os = "linux", feature = "avsdk-loader-probe"))]
pub(crate) fn snapshot() -> AvsdkLoaderProbeSnapshot {
    enabled::snapshot()
}

#[cfg(all(target_os = "linux", feature = "avsdk-loader-probe"))]
pub(crate) fn register_napi_cleanup(env: napi::sys::napi_env) {
    enabled::register_napi_cleanup(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_off_status_is_inert_and_has_only_fixed_fields() {
        assert_eq!(snapshot(), AvsdkLoaderProbeSnapshot::default());
        let keys = [
            "prepared",
            "observed",
            "unique",
            "sameObject",
            "sameNamespace",
            "buildMatch",
            "flagsCompatible",
            "observationCount",
        ];
        assert_eq!(keys.len(), 8);
    }
}
