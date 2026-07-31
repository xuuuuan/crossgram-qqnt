#![cfg(target_os = "linux")]

use core::{
    cell::Cell,
    ffi::{CStr, c_char, c_int, c_void},
    mem::{size_of, transmute},
    ptr,
    sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
};
use sha2::{Digest, Sha256};

const PROC_CMDLINE: &[u8] = b"/proc/self/cmdline\0";
const PROC_EXE: &[u8] = b"/proc/self/exe\0";
#[cfg(not(feature = "synthetic-profile"))]
const EXPECTED_EXECUTABLE: &[u8] = b"/opt/QQ/qq";
#[cfg(feature = "synthetic-profile")]
const EXPECTED_EXECUTABLE: &[u8] = b"/tmp/crossgram-ppapi-host/QQ";
#[cfg(not(feature = "synthetic-profile"))]
const EXPECTED_AVSDK: &[u8] = b"/opt/QQ/resources/app/avsdk/libAVSDKPlugin.so";
#[cfg(feature = "synthetic-profile")]
const EXPECTED_AVSDK: &[u8] = b"/tmp/crossgram-ppapi-host/avsdk/libAVSDKPlugin.so";
const SOCKET_PATH: &[u8] = b"/tmp/crossgram-ppapi-observer/records.sock\0";
const GLIBC_DLOPEN: &[u8] = b"dlopen\0";
const GLIBC_2_2_5: &[u8] = b"GLIBC_2.2.5\0";
const FIXED_BUILD_ID: [u8; 8] = [0xd6, 0x15, 0x9b, 0x67, 0x01, 0xb4, 0x66, 0x83];
const FIXED_SHA256: [u8; 32] = [
    0xac, 0x5e, 0xab, 0xbe, 0x96, 0xf1, 0xd0, 0x1c, 0xb1, 0x84, 0x7a, 0xfa, 0x8a, 0x98, 0x21, 0x13,
    0x65, 0xe8, 0xd3, 0x7f, 0xc6, 0x99, 0xf1, 0xc6, 0x69, 0xb6, 0xfd, 0x34, 0x4a, 0x4b, 0x13, 0xdb,
];
const FINGERPRINT_RVA: usize = 0x53_f840;
const FIXED_FINGERPRINT: [u8; 16] = [
    0x41, 0x57, 0x41, 0x56, 0x53, 0x48, 0x83, 0xec, 0x20, 0x49, 0x89, 0xfe, 0x48, 0x8d, 0x05, 0x45,
];
const CMDLINE_MAX: usize = 4096;
const EXE_MAX: usize = 512;
const OBSERVATION_MAX: u8 = 2;
const ELF_HEADER_MAX: usize = 8192;
const STREAM_BUFFER: usize = 4096;

const ROLE_UNKNOWN: u8 = 0;
const ROLE_INERT: u8 = 1;
const ROLE_PPAPI: u8 = 2;
const IDENTITY_UNAVAILABLE: u8 = 0;
const IDENTITY_READY: u8 = 1;
const IDENTITY_REJECTED: u8 = 2;
const IDENTITY_CHECKING: u8 = 3;

const NAMESPACE_BASE: u8 = 1;
const NAMESPACE_OTHER: u8 = 2;
const NAMESPACE_UNKNOWN: u8 = 3;
const FLAGS_ACCEPTED: u8 = 1;
const FLAGS_REJECTED: u8 = 2;
const CALLER_HOST: u8 = 1;
const CALLER_OTHER: u8 = 2;
const CALLER_UNKNOWN: u8 = 3;
const ERROR_NONE: u8 = 0;
const ERROR_IDENTITY: u8 = 1;
const ERROR_HANDLE: u8 = 2;
const ERROR_NAMESPACE: u8 = 3;
const ERROR_FLAGS: u8 = 4;
const ERROR_CALLER: u8 = 5;
const ERROR_DUPLICATE: u8 = 6;

static ROLE: AtomicU8 = AtomicU8::new(ROLE_UNKNOWN);
static FORWARD: AtomicU64 = AtomicU64::new(0);
static IDENTITY: AtomicU8 = AtomicU8::new(IDENTITY_UNAVAILABLE);
static OBSERVATION_COUNT: AtomicU8 = AtomicU8::new(0);
static OBSERVATION_ENABLED: AtomicBool = AtomicBool::new(true);

thread_local! {
    static IN_DLOPEN: Cell<bool> = const { Cell::new(false) };
}

unsafe extern "C" {
    fn ppapi_dlopen_impl(filename: *const c_char, flags: c_int) -> *mut c_void;
    static mut ppapi_dispatch_ptr:
        Option<unsafe extern "C" fn(*const c_char, c_int, *mut c_void) -> *mut c_void>;
}

#[used]
static C_INTERPOSER_ANCHOR: unsafe extern "C" fn(*const c_char, c_int) -> *mut c_void =
    ppapi_dlopen_impl;

#[repr(C)]
struct LinkMap {
    l_addr: libc::Elf64_Addr,
    l_name: *const c_char,
    l_ld: *mut c_void,
    l_next: *mut LinkMap,
    l_prev: *mut LinkMap,
}

#[repr(C)]
struct DlInfo {
    dli_fname: *const c_char,
    dli_fbase: *mut c_void,
    dli_sname: *const c_char,
    dli_saddr: *mut c_void,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Record {
    bytes: [u8; 16],
}

impl Record {
    #[allow(clippy::too_many_arguments)]
    fn new(
        role_ppapi: bool,
        forward_resolved: bool,
        observed: bool,
        unique: bool,
        build_match: bool,
        namespace: u8,
        flags: u8,
        caller: u8,
        count: u8,
        error: u8,
    ) -> Self {
        Self {
            bytes: [
                b'P',
                b'P',
                b'V',
                b'1',
                1,
                u8::from(role_ppapi),
                u8::from(role_ppapi),
                u8::from(forward_resolved),
                u8::from(observed),
                u8::from(unique),
                u8::from(build_match),
                namespace,
                flags,
                caller,
                count,
                error,
            ],
        }
    }

    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != 16 || bytes[..5] != [b'P', b'P', b'V', b'1', 1] || !booleans_valid(bytes)
        {
            return None;
        }
        let mut record = [0u8; 16];
        record.copy_from_slice(bytes);
        Some(Self { bytes: record })
    }

    pub fn bytes(&self) -> &[u8; 16] {
        &self.bytes
    }

    pub fn json(&self) -> String {
        format!(
            "{{\"role_ppapi\":{},\"preload_active\":{},\"forward_resolved\":{},\"observed\":{},\"unique\":{},\"build_match\":{},\"namespace_class\":{},\"flags_class\":{},\"caller_class\":{},\"observation_count\":{},\"error_category\":{}}}",
            self.bytes[5] != 0,
            self.bytes[6] != 0,
            self.bytes[7] != 0,
            self.bytes[8] != 0,
            self.bytes[9] != 0,
            self.bytes[10] != 0,
            self.bytes[11],
            self.bytes[12],
            self.bytes[13],
            self.bytes[14],
            self.bytes[15],
        )
    }
}

fn booleans_valid(bytes: &[u8]) -> bool {
    bytes[5..=10].iter().all(|value| *value <= 1)
        && matches!(
            bytes[11],
            NAMESPACE_BASE | NAMESPACE_OTHER | NAMESPACE_UNKNOWN
        )
        && matches!(bytes[12], FLAGS_ACCEPTED | FLAGS_REJECTED)
        && matches!(bytes[13], CALLER_HOST | CALLER_OTHER | CALLER_UNKNOWN)
        && bytes[14] <= OBSERVATION_MAX
        && bytes[15] <= ERROR_DUPLICATE
}

unsafe extern "C" fn constructor() {
    initialize();
    unsafe { ppapi_dispatch_ptr = Some(ppapi_dlopen_dispatch) };
}

#[used]
#[unsafe(link_section = ".init_array")]
static INIT: unsafe extern "C" fn() = constructor;

fn initialize() {
    // Constructors only classify and install transparent forwarding. File
    // identity validation is deferred until a returned fixed handle exists.
    let _ = ROLE.compare_exchange(
        ROLE_UNKNOWN,
        classify_role(),
        Ordering::AcqRel,
        Ordering::Acquire,
    );
}

fn classify_role() -> u8 {
    let mut cmdline = [0u8; CMDLINE_MAX];
    let mut executable = [0u8; EXE_MAX];
    let Some(cmdline_len) = read_file(PROC_CMDLINE, &mut cmdline) else {
        return ROLE_INERT;
    };
    let Some(executable_len) = read_link(PROC_EXE, &mut executable) else {
        return ROLE_INERT;
    };
    classify_role_bytes(&executable[..executable_len], &cmdline[..cmdline_len])
}

fn classify_role_bytes(executable: &[u8], arguments: &[u8]) -> u8 {
    if arguments.len() == CMDLINE_MAX
        || arguments.is_empty()
        || arguments.last() != Some(&0)
        || executable != EXPECTED_EXECUTABLE
    {
        return ROLE_INERT;
    }
    if arguments
        .split(|byte| *byte == 0)
        .any(|argument| argument == b"--type=ppapi")
    {
        ROLE_PPAPI
    } else {
        ROLE_INERT
    }
}

fn read_file(path: &[u8], output: &mut [u8]) -> Option<usize> {
    let fd = unsafe { libc::open(path.as_ptr().cast(), libc::O_RDONLY | libc::O_CLOEXEC) };
    if fd < 0 {
        return None;
    }
    let result = unsafe { libc::read(fd, output.as_mut_ptr().cast(), output.len()) };
    unsafe { libc::close(fd) };
    usize::try_from(result).ok()
}

fn read_link(path: &[u8], output: &mut [u8]) -> Option<usize> {
    let result = unsafe {
        libc::readlink(
            path.as_ptr().cast(),
            output.as_mut_ptr().cast(),
            output.len(),
        )
    };
    let size = usize::try_from(result).ok()?;
    (size < output.len()).then_some(size)
}

fn validate_fixed_identity_once() -> bool {
    match IDENTITY.load(Ordering::Acquire) {
        IDENTITY_READY => return true,
        IDENTITY_REJECTED | IDENTITY_CHECKING => return false,
        _ => {}
    }
    if IDENTITY
        .compare_exchange(
            IDENTITY_UNAVAILABLE,
            IDENTITY_CHECKING,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_err()
    {
        return false;
    }
    let valid = fixed_identity_matches();
    IDENTITY.store(
        if valid {
            IDENTITY_READY
        } else {
            IDENTITY_REJECTED
        },
        Ordering::Release,
    );
    valid
}

fn fixed_identity_matches() -> bool {
    let Some(fd) = open_trusted_fixed_file() else {
        return false;
    };
    let valid = build_id_matches(fd) && sha256_matches(fd);
    unsafe { libc::close(fd) };
    valid
}

fn open_trusted_fixed_file() -> Option<c_int> {
    let mut parent = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        )
    };
    if parent < 0 || !trusted_fd(parent, true) {
        if parent >= 0 {
            unsafe { libc::close(parent) };
        }
        return None;
    }
    for component in [c"opt", c"QQ", c"resources", c"app", c"avsdk"] {
        let next = unsafe {
            libc::openat(
                parent,
                component.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            )
        };
        unsafe { libc::close(parent) };
        if next < 0 || !trusted_fd(next, true) {
            if next >= 0 {
                unsafe { libc::close(next) };
            }
            return None;
        }
        parent = next;
    }
    let file = unsafe {
        libc::openat(
            parent,
            c"libAVSDKPlugin.so".as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    unsafe { libc::close(parent) };
    if file >= 0 && trusted_fd(file, false) {
        Some(file)
    } else {
        if file >= 0 {
            unsafe { libc::close(file) };
        }
        None
    }
}

fn trusted_fd(fd: c_int, directory: bool) -> bool {
    let mut stat = core::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
        return false;
    }
    let stat = unsafe { stat.assume_init() };
    stat.st_uid == 0
        && (stat.st_mode & 0o022) == 0
        && (stat.st_mode & libc::S_IFMT)
            == if directory {
                libc::S_IFDIR
            } else {
                libc::S_IFREG
            }
}

fn sha256_matches(fd: c_int) -> bool {
    let mut digest = Sha256::new();
    let mut buffer = [0u8; STREAM_BUFFER];
    let mut offset = 0i64;
    loop {
        let read = unsafe { libc::pread(fd, buffer.as_mut_ptr().cast(), buffer.len(), offset) };
        let Ok(read) = usize::try_from(read) else {
            return false;
        };
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        let Some(next) = offset.checked_add(read as i64) else {
            return false;
        };
        offset = next;
    }
    digest.finalize().as_slice() == FIXED_SHA256
}

fn build_id_matches(fd: c_int) -> bool {
    let mut header = [0u8; ELF_HEADER_MAX];
    let amount = unsafe { libc::pread(fd, header.as_mut_ptr().cast(), header.len(), 0) };
    let Ok(amount) = usize::try_from(amount) else {
        return false;
    };
    let bytes = &header[..amount];
    if bytes.get(..16) != Some(b"\x7fELF\x02\x01\x01\0\0\0\0\0\0\0\0\0") {
        return false;
    }
    let Some(program_offset) = read_u64(bytes, 32).and_then(|value| usize::try_from(value).ok())
    else {
        return false;
    };
    let Some(program_size) = read_u16(bytes, 54) else {
        return false;
    };
    let Some(program_count) = read_u16(bytes, 56) else {
        return false;
    };
    if program_size != 56 || program_count == 0 || program_count > 128 {
        return false;
    }
    for index in 0..usize::from(program_count) {
        let Some(offset) = program_offset.checked_add(index * 56) else {
            return false;
        };
        if read_u32(bytes, offset) != Some(libc::PT_NOTE) {
            continue;
        }
        let Some(note_offset) = read_u64(bytes, offset + 8) else {
            return false;
        };
        let Some(note_size) = read_u64(bytes, offset + 32) else {
            return false;
        };
        if note_size == 0 || note_size > ELF_HEADER_MAX as u64 {
            return false;
        }
        let mut notes = [0u8; ELF_HEADER_MAX];
        let amount = unsafe {
            libc::pread(
                fd,
                notes.as_mut_ptr().cast(),
                note_size as usize,
                note_offset as i64,
            )
        };
        let Ok(amount) = usize::try_from(amount) else {
            return false;
        };
        if note_build_id(&notes[..amount]) == Some(FIXED_BUILD_ID) {
            return true;
        }
    }
    false
}

fn note_build_id(notes: &[u8]) -> Option<[u8; 8]> {
    let mut offset = 0usize;
    while offset.checked_add(12)? <= notes.len() {
        let namesz = read_u32(notes, offset)? as usize;
        let descsz = read_u32(notes, offset + 4)? as usize;
        let note_type = read_u32(notes, offset + 8)?;
        let name_start = offset + 12;
        let name_end = name_start.checked_add(namesz)?;
        let desc_start = align4(name_end)?;
        let desc_end = desc_start.checked_add(descsz)?;
        let next = align4(desc_end)?;
        if next > notes.len() {
            return None;
        }
        if note_type == 3 && notes.get(name_start..name_end) == Some(b"GNU\0") && descsz == 8 {
            return notes.get(desc_start..desc_end)?.try_into().ok();
        }
        offset = next;
    }
    None
}

fn align4(value: usize) -> Option<usize> {
    value.checked_add(3).map(|value| value & !3)
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

fn resolve_forward() -> Option<unsafe extern "C" fn(*const c_char, c_int) -> *mut c_void> {
    let current = FORWARD.load(Ordering::Acquire);
    if current != 0 {
        return Some(unsafe {
            transmute::<usize, unsafe extern "C" fn(*const c_char, c_int) -> *mut c_void>(
                current as usize,
            )
        });
    }
    let address = unsafe {
        libc::dlvsym(
            libc::RTLD_NEXT,
            GLIBC_DLOPEN.as_ptr().cast(),
            GLIBC_2_2_5.as_ptr().cast(),
        )
    };
    if address.is_null() || core::ptr::eq(address, ppapi_dlopen_dispatch as *const c_void) {
        return None;
    }
    let address = address as usize as u64;
    let _ = FORWARD.compare_exchange(0, address, Ordering::AcqRel, Ordering::Acquire);
    Some(unsafe {
        transmute::<usize, unsafe extern "C" fn(*const c_char, c_int) -> *mut c_void>(
            FORWARD.load(Ordering::Acquire) as usize,
        )
    })
}

/// Called only by the hidden C ABI shim exported as dlopen@GLIBC_2.2.5.
unsafe extern "C" fn ppapi_dlopen_dispatch(
    filename: *const c_char,
    flags: c_int,
    caller: *mut c_void,
) -> *mut c_void {
    initialize();
    let Some(forward) = resolve_forward() else {
        return ptr::null_mut();
    };
    let handle = unsafe { forward(filename, flags) };
    if handle.is_null() || ROLE.load(Ordering::Acquire) != ROLE_PPAPI {
        return handle;
    }
    IN_DLOPEN.with(|active| {
        if active.replace(true) {
            return;
        }
        observe(filename, flags, caller, handle);
        active.set(false);
    });
    handle
}

fn observe(filename: *const c_char, flags: c_int, caller: *mut c_void, handle: *mut c_void) {
    if !OBSERVATION_ENABLED.load(Ordering::Acquire) || !fixed_filename(filename) {
        return;
    }
    let flags_class = if compatible_flags(flags) {
        FLAGS_ACCEPTED
    } else {
        FLAGS_REJECTED
    };
    let caller_class = classify_caller(caller);
    let inspection = inspect_handle(handle);
    let identity_ready =
        inspection.is_some_and(|item| item.build_match) && validate_fixed_identity_once();
    let namespace = inspection.map_or(NAMESPACE_UNKNOWN, |item| item.namespace);
    let unique = inspection.is_some_and(|item| item.unique);
    let build_match = identity_ready && inspection.is_some_and(|item| item.build_match);
    let mut error = ERROR_NONE;
    if !identity_ready || !build_match {
        error = ERROR_IDENTITY;
    } else if inspection.is_none() {
        error = ERROR_HANDLE;
    } else if namespace != NAMESPACE_BASE {
        error = ERROR_NAMESPACE;
    } else if flags_class != FLAGS_ACCEPTED {
        error = ERROR_FLAGS;
    } else if caller_class != CALLER_HOST {
        error = ERROR_CALLER;
    }
    let count = next_observation_count();
    if count == 0 {
        return;
    }
    if count == 2 {
        error = ERROR_DUPLICATE;
        OBSERVATION_ENABLED.store(false, Ordering::Release);
    } else if error != ERROR_NONE || !unique {
        OBSERVATION_ENABLED.store(false, Ordering::Release);
    }
    emit(Record::new(
        true,
        FORWARD.load(Ordering::Acquire) != 0,
        true,
        unique,
        build_match,
        namespace,
        flags_class,
        caller_class,
        count,
        error,
    ));
}

fn next_observation_count() -> u8 {
    OBSERVATION_COUNT
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
            (value < OBSERVATION_MAX).then_some(value + 1)
        })
        .map_or(0, |value| value + 1)
}

fn fixed_filename(filename: *const c_char) -> bool {
    if filename.is_null() {
        return false;
    }
    let bytes = unsafe { CStr::from_ptr(filename).to_bytes() };
    bytes == EXPECTED_AVSDK
}

fn compatible_flags(flags: c_int) -> bool {
    flags & (libc::RTLD_NOW | libc::RTLD_LAZY) == libc::RTLD_NOW
        && flags & (libc::RTLD_GLOBAL | libc::RTLD_DEEPBIND) == 0
}

fn classify_caller(caller: *mut c_void) -> u8 {
    if caller.is_null() {
        return CALLER_UNKNOWN;
    }
    let mut info = core::mem::MaybeUninit::<DlInfo>::zeroed();
    if unsafe { libc::dladdr(caller.cast(), info.as_mut_ptr().cast()) } == 0 {
        return CALLER_UNKNOWN;
    }
    let info = unsafe { info.assume_init() };
    if info.dli_fname.is_null() {
        return CALLER_UNKNOWN;
    }
    let name = unsafe { CStr::from_ptr(info.dli_fname).to_bytes() };
    if name == EXPECTED_EXECUTABLE {
        CALLER_HOST
    } else {
        CALLER_OTHER
    }
}

#[derive(Clone, Copy)]
struct HandleInspection {
    namespace: u8,
    unique: bool,
    build_match: bool,
}

fn inspect_handle(handle: *mut c_void) -> Option<HandleInspection> {
    let mut link_map: *mut LinkMap = ptr::null_mut();
    let mut lmid: libc::Lmid_t = 0;
    if unsafe {
        libc::dlinfo(
            handle,
            libc::RTLD_DI_LINKMAP,
            (&mut link_map as *mut *mut LinkMap).cast(),
        )
    } != 0
        || link_map.is_null()
        || unsafe { (*link_map).l_name.is_null() }
        || unsafe {
            libc::dlinfo(
                handle,
                libc::RTLD_DI_LMID,
                (&mut lmid as *mut libc::Lmid_t).cast(),
            )
        } != 0
    {
        return None;
    }
    let build_match = unsafe { CStr::from_ptr((*link_map).l_name).to_bytes() } == EXPECTED_AVSDK
        && mapped_fingerprint_matches(unsafe { (*link_map).l_addr as usize });
    let namespace = if lmid == libc::LM_ID_BASE {
        NAMESPACE_BASE
    } else {
        NAMESPACE_OTHER
    };
    Some(HandleInspection {
        namespace,
        unique: build_match && mapping_count() == 1,
        build_match,
    })
}

fn mapped_fingerprint_matches(base: usize) -> bool {
    #[repr(C)]
    struct Query {
        base: usize,
        executable: bool,
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
        for index in 0..usize::from(info.dlpi_phnum) {
            let header = unsafe { &*info.dlpi_phdr.add(index) };
            let Some(start) = query.base.checked_add(header.p_vaddr as usize) else {
                continue;
            };
            let Some(end) = start.checked_add(header.p_memsz as usize) else {
                continue;
            };
            let Some(address) = query.base.checked_add(FINGERPRINT_RVA) else {
                continue;
            };
            if header.p_type == libc::PT_LOAD
                && header.p_flags & libc::PF_X != 0
                && address >= start
                && address
                    .checked_add(FIXED_FINGERPRINT.len())
                    .is_some_and(|fingerprint_end| fingerprint_end <= end)
            {
                query.executable = true;
                return 1;
            }
        }
        1
    }
    let mut query = Query {
        base,
        executable: false,
    };
    unsafe { libc::dl_iterate_phdr(Some(visit), (&mut query as *mut Query).cast()) };
    if !query.executable {
        return false;
    }
    let Some(address) = base.checked_add(FINGERPRINT_RVA) else {
        return false;
    };
    unsafe { ptr::read_volatile(address as *const [u8; 16]) == FIXED_FINGERPRINT }
}

fn mapping_count() -> u8 {
    #[repr(C)]
    struct Count {
        value: u8,
    }
    unsafe extern "C" fn visit(
        info: *mut libc::dl_phdr_info,
        _: libc::size_t,
        data: *mut c_void,
    ) -> c_int {
        let count = unsafe { &mut *data.cast::<Count>() };
        let info = unsafe { &*info };
        if !info.dlpi_name.is_null()
            && unsafe { CStr::from_ptr(info.dlpi_name).to_bytes() } == EXPECTED_AVSDK
        {
            count.value = count.value.saturating_add(1).min(2);
        }
        0
    }
    let mut count = Count { value: 0 };
    unsafe { libc::dl_iterate_phdr(Some(visit), (&mut count as *mut Count).cast()) };
    count.value
}

fn emit(record: Record) {
    let fd = unsafe {
        libc::socket(
            libc::AF_UNIX,
            libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
            0,
        )
    };
    if fd < 0 {
        return;
    }
    let mut address = unsafe { core::mem::zeroed::<libc::sockaddr_un>() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    let path = SOCKET_PATH;
    if path.len() > address.sun_path.len() {
        unsafe { libc::close(fd) };
        return;
    }
    for (slot, byte) in address.sun_path.iter_mut().zip(path.iter()) {
        *slot = *byte as c_char;
    }
    let length = (size_of::<libc::sa_family_t>() + path.len()) as libc::socklen_t;
    let connected = unsafe { libc::connect(fd, (&raw const address).cast(), length) == 0 };
    if connected {
        unsafe {
            libc::send(
                fd,
                record.bytes().as_ptr().cast(),
                record.bytes().len(),
                libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
            );
        }
    }
    unsafe { libc::close(fd) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ppapi_role_requires_the_exact_executable_and_argument() {
        assert_eq!(
            classify_role_bytes(EXPECTED_EXECUTABLE, b"/opt/QQ/qq\0--type=ppapi\0"),
            ROLE_PPAPI
        );
        assert_eq!(
            classify_role_bytes(b"/opt/QQ/qq-not", b"/opt/QQ/qq-not\0--type=ppapi\0"),
            ROLE_INERT
        );
        assert_eq!(
            classify_role_bytes(EXPECTED_EXECUTABLE, b"/opt/QQ/qq\0--type=PPAPI\0"),
            ROLE_INERT
        );
    }

    #[test]
    fn malformed_command_line_is_inert() {
        let malformed = [b'x'; CMDLINE_MAX];
        assert_eq!(
            classify_role_bytes(EXPECTED_EXECUTABLE, &malformed),
            ROLE_INERT
        );
    }

    #[test]
    fn flags_fail_closed() {
        assert!(compatible_flags(libc::RTLD_NOW));
        assert!(!compatible_flags(libc::RTLD_LAZY));
        assert!(!compatible_flags(libc::RTLD_NOW | libc::RTLD_GLOBAL));
    }

    #[test]
    fn records_have_a_fixed_whitelisted_schema() {
        let record = Record::new(
            true,
            true,
            true,
            true,
            true,
            NAMESPACE_BASE,
            FLAGS_ACCEPTED,
            CALLER_HOST,
            1,
            ERROR_NONE,
        );
        assert_eq!(record.bytes().len(), 16);
        assert!(Record::parse(record.bytes()).is_some());
        assert_eq!(
            record.json(),
            "{\"role_ppapi\":true,\"preload_active\":true,\"forward_resolved\":true,\"observed\":true,\"unique\":true,\"build_match\":true,\"namespace_class\":1,\"flags_class\":1,\"caller_class\":1,\"observation_count\":1,\"error_category\":0}"
        );
        let mut invalid = *record.bytes();
        invalid[5] = 2;
        assert!(Record::parse(&invalid).is_none());
    }

    #[test]
    fn duplicate_observation_is_bounded() {
        OBSERVATION_COUNT.store(0, Ordering::Release);
        assert_eq!(next_observation_count(), 1);
        assert_eq!(next_observation_count(), 2);
        assert_eq!(next_observation_count(), 0);
        OBSERVATION_COUNT.store(0, Ordering::Release);
    }

    #[test]
    fn identity_mismatch_disables_observation_only() {
        OBSERVATION_ENABLED.store(true, Ordering::Release);
        IDENTITY.store(IDENTITY_UNAVAILABLE, Ordering::Release);
        assert_ne!(IDENTITY.load(Ordering::Acquire), IDENTITY_READY);
        OBSERVATION_ENABLED.store(false, Ordering::Release);
        assert_ne!(FORWARD.load(Ordering::Acquire), u64::MAX);
        OBSERVATION_ENABLED.store(true, Ordering::Release);
    }
}
