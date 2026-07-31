use sha2::{Digest, Sha256};
use thiserror::Error;

const ELF_HEADER_SIZE: usize = 64;
const PROGRAM_HEADER_SIZE: usize = 56;
const DYNAMIC_ENTRY_SIZE: usize = 16;
const RELA_ENTRY_SIZE: usize = 24;
const MAX_PROGRAM_HEADERS: usize = 128;
const MAX_DYNAMIC_ENTRIES: usize = 4096;
const MAX_RELA_ENTRIES: usize = 1_000_000;

const PT_LOAD: u32 = 1;
const PT_DYNAMIC: u32 = 2;
const PT_NOTE: u32 = 4;
const PF_X: u32 = 1;
const PF_W: u32 = 2;
const PF_R: u32 = 4;
const DT_NULL: i64 = 0;
const DT_RELA: i64 = 7;
const DT_RELASZ: i64 = 8;
const DT_RELAENT: i64 = 9;
const R_X86_64_RELATIVE: u32 = 8;

#[derive(Debug, Error)]
pub enum ElfError {
    #[error("wrapper.node is not loaded in this process")]
    ModuleNotLoaded,
    #[error("multiple wrapper.node modules are loaded in this process")]
    ModuleAmbiguous,
    #[error("failed to read wrapper.node from disk: {0}")]
    ModuleRead(#[source] std::io::Error),
    #[error("ELF image is truncated")]
    Truncated,
    #[error("ELF image is not a little-endian x86_64 ELF64 shared object")]
    UnsupportedElf,
    #[error("ELF program headers exceed parser limits")]
    ProgramHeaders,
    #[error("ELF virtual address is not file-backed by a PT_LOAD segment")]
    VirtualAddress,
    #[error("ELF GNU Build ID is missing")]
    BuildIdMissing,
    #[error("ELF dynamic RELA table is invalid")]
    RelaTable,
    #[error("QQNT wrapper.node build is not an approved packet-binding profile")]
    UnsupportedProfile,
    #[error("approved profile's binding name is not a read-only PT_LOAD address")]
    BindingNamePermissions,
    #[error("approved profile's N-API callback is not an executable PT_LOAD address")]
    NapiCallbackPermissions,
    #[error("approved profile's response action is not an executable PT_LOAD address")]
    ResponseActionPermissions,
    #[error("approved profile's converter is not an executable PT_LOAD address")]
    ConverterPermissions,
    #[error("approved profile's resolve action is not an executable PT_LOAD address")]
    ResolveActionPermissions,
    #[error("approved profile's name slot is not a writable PT_LOAD address")]
    NameSlotPermissions,
    #[error("approved profile's N-API callback slot is not a writable PT_LOAD address")]
    NapiCallbackSlotPermissions,
    #[error("approved profile's response action slot is not a writable PT_LOAD address")]
    ResponseActionSlotPermissions,
    #[error("approved profile's binding name does not match")]
    BindingName,
    #[error("approved profile's N-API callback fingerprint does not match")]
    NapiCallbackFingerprint,
    #[error("approved profile's response action fingerprint does not match")]
    ResponseActionFingerprint,
    #[error("approved profile's converter fingerprint does not match")]
    ConverterFingerprint,
    #[error("approved profile's resolve action fingerprint does not match")]
    ResolveActionFingerprint,
    #[error("approved profile's name RELA entry does not match")]
    NameRela,
    #[error("approved profile's N-API callback RELA entry does not match")]
    NapiCallbackRela,
    #[error("approved profile's response action RELA entry does not match")]
    ResponseActionRela,
    #[error("loaded name slot does not point at the approved name")]
    NameValue,
    #[error("loaded N-API callback slot does not point at the approved wrapper")]
    NapiCallbackValue,
    #[error("loaded response action slot does not point at the approved response lambda")]
    ResponseActionValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgramHeader {
    pub kind: u32,
    pub flags: u32,
    pub offset: u64,
    pub virtual_address: u64,
    pub file_size: u64,
    pub memory_size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DynamicEntry {
    tag: i64,
    value: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rela {
    offset: u64,
    info: u64,
    addend: i64,
}

#[derive(Debug)]
pub struct ElfImage<'a> {
    bytes: &'a [u8],
    program_headers: Vec<ProgramHeader>,
}

impl<'a> ElfImage<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, ElfError> {
        if bytes.len() < ELF_HEADER_SIZE {
            return Err(ElfError::Truncated);
        }
        if bytes.get(..4) != Some(b"\x7fELF")
            || bytes[4] != 2
            || bytes[5] != 1
            || bytes[6] != 1
            || read_u16(bytes, 16)? != 3
            || read_u16(bytes, 18)? != 62
            || read_u32(bytes, 20)? != 1
            || read_u16(bytes, 52)? != ELF_HEADER_SIZE as u16
            || read_u16(bytes, 54)? != PROGRAM_HEADER_SIZE as u16
        {
            return Err(ElfError::UnsupportedElf);
        }

        let program_offset =
            usize::try_from(read_u64(bytes, 32)?).map_err(|_| ElfError::Truncated)?;
        let program_count = usize::from(read_u16(bytes, 56)?);
        if program_count == 0 || program_count > MAX_PROGRAM_HEADERS {
            return Err(ElfError::ProgramHeaders);
        }
        let program_size = program_count
            .checked_mul(PROGRAM_HEADER_SIZE)
            .and_then(|size| program_offset.checked_add(size))
            .ok_or(ElfError::Truncated)?;
        if program_size > bytes.len() {
            return Err(ElfError::Truncated);
        }

        let mut program_headers = Vec::with_capacity(program_count);
        for index in 0..program_count {
            let offset = program_offset + index * PROGRAM_HEADER_SIZE;
            program_headers.push(ProgramHeader {
                kind: read_u32(bytes, offset)?,
                flags: read_u32(bytes, offset + 4)?,
                offset: read_u64(bytes, offset + 8)?,
                virtual_address: read_u64(bytes, offset + 16)?,
                file_size: read_u64(bytes, offset + 32)?,
                memory_size: read_u64(bytes, offset + 40)?,
            });
        }
        Ok(Self {
            bytes,
            program_headers,
        })
    }

    pub fn build_id(&self) -> Result<Vec<u8>, ElfError> {
        for header in self
            .program_headers
            .iter()
            .filter(|header| header.kind == PT_NOTE)
        {
            let start = usize::try_from(header.offset).map_err(|_| ElfError::Truncated)?;
            let note_end = header
                .file_size
                .try_into()
                .ok()
                .and_then(|size: usize| start.checked_add(size))
                .filter(|end| *end <= self.bytes.len())
                .ok_or(ElfError::Truncated)?;
            let mut cursor = start;
            while cursor < note_end {
                let name_size = usize::try_from(read_u32(self.bytes, cursor)?)
                    .map_err(|_| ElfError::Truncated)?;
                let desc_size = usize::try_from(read_u32(self.bytes, cursor + 4)?)
                    .map_err(|_| ElfError::Truncated)?;
                let note_type = read_u32(self.bytes, cursor + 8)?;
                let name_start = cursor.checked_add(12).ok_or(ElfError::Truncated)?;
                let name_end = name_start
                    .checked_add(name_size)
                    .filter(|end| *end <= note_end)
                    .ok_or(ElfError::Truncated)?;
                let desc_start = align4(name_end).ok_or(ElfError::Truncated)?;
                let desc_end = desc_start
                    .checked_add(desc_size)
                    .filter(|end| *end <= note_end)
                    .ok_or(ElfError::Truncated)?;
                let next = align4(desc_end)
                    .filter(|next| *next <= note_end)
                    .ok_or(ElfError::Truncated)?;
                if note_type == 3 && self.bytes.get(name_start..name_end) == Some(b"GNU\0") {
                    return Ok(self.bytes[desc_start..desc_end].to_vec());
                }
                cursor = next;
            }
        }
        Err(ElfError::BuildIdMissing)
    }

    pub fn sha256(&self) -> [u8; 32] {
        Sha256::digest(self.bytes).into()
    }

    #[cfg(feature = "avsdk-loader-probe")]
    pub fn executable_bytes(&self, address: u64, length: u64) -> Result<&[u8], ElfError> {
        if self
            .load_for_range(address, length)
            .is_none_or(|header| header.flags & (PF_R | PF_W | PF_X) != (PF_R | PF_X))
        {
            return Err(ElfError::VirtualAddress);
        }
        let offset = self.file_offset_for_range(address, length)?;
        self.bytes
            .get(offset..offset + usize::try_from(length).map_err(|_| ElfError::VirtualAddress)?)
            .ok_or(ElfError::VirtualAddress)
    }

    fn load_for_range(&self, address: u64, length: u64) -> Option<ProgramHeader> {
        let end = address.checked_add(length)?;
        self.program_headers.iter().copied().find(|header| {
            header.kind == PT_LOAD
                && address >= header.virtual_address
                && end
                    <= header
                        .virtual_address
                        .checked_add(header.memory_size)
                        .unwrap_or(0)
        })
    }

    fn file_offset_for_range(&self, address: u64, length: u64) -> Result<usize, ElfError> {
        let end = address
            .checked_add(length)
            .ok_or(ElfError::VirtualAddress)?;
        let header = self
            .program_headers
            .iter()
            .find(|header| {
                header.kind == PT_LOAD
                    && address >= header.virtual_address
                    && end
                        <= header
                            .virtual_address
                            .checked_add(header.file_size)
                            .unwrap_or(0)
            })
            .ok_or(ElfError::VirtualAddress)?;
        let offset = header
            .offset
            .checked_add(address - header.virtual_address)
            .and_then(|offset| usize::try_from(offset).ok())
            .ok_or(ElfError::VirtualAddress)?;
        let end = offset
            .checked_add(usize::try_from(length).map_err(|_| ElfError::VirtualAddress)?)
            .filter(|end| *end <= self.bytes.len())
            .ok_or(ElfError::VirtualAddress)?;
        let _ = end;
        Ok(offset)
    }

    fn dynamic_entries(&self) -> Result<Vec<DynamicEntry>, ElfError> {
        let headers: Vec<_> = self
            .program_headers
            .iter()
            .filter(|header| header.kind == PT_DYNAMIC)
            .collect();
        if headers.len() != 1 || headers[0].file_size % DYNAMIC_ENTRY_SIZE as u64 != 0 {
            return Err(ElfError::RelaTable);
        }
        let header = headers[0];
        let count = usize::try_from(header.file_size / DYNAMIC_ENTRY_SIZE as u64)
            .map_err(|_| ElfError::RelaTable)?;
        if count == 0 || count > MAX_DYNAMIC_ENTRIES {
            return Err(ElfError::RelaTable);
        }
        let start = usize::try_from(header.offset).map_err(|_| ElfError::Truncated)?;
        let end = count
            .checked_mul(DYNAMIC_ENTRY_SIZE)
            .and_then(|size| start.checked_add(size))
            .filter(|end| *end <= self.bytes.len())
            .ok_or(ElfError::Truncated)?;
        let mut entries = Vec::with_capacity(count);
        for offset in (start..end).step_by(DYNAMIC_ENTRY_SIZE) {
            let entry = DynamicEntry {
                tag: read_i64(self.bytes, offset)?,
                value: read_u64(self.bytes, offset + 8)?,
            };
            entries.push(entry);
            if entry.tag == DT_NULL {
                break;
            }
        }
        Ok(entries)
    }

    fn rela_entries(&self) -> Result<Vec<Rela>, ElfError> {
        let dynamic = self.dynamic_entries()?;
        let rela_address = dynamic_value(&dynamic, DT_RELA).ok_or(ElfError::RelaTable)?;
        let rela_size = dynamic_value(&dynamic, DT_RELASZ).ok_or(ElfError::RelaTable)?;
        if dynamic_value(&dynamic, DT_RELAENT) != Some(RELA_ENTRY_SIZE as u64)
            || rela_size == 0
            || rela_size % RELA_ENTRY_SIZE as u64 != 0
        {
            return Err(ElfError::RelaTable);
        }
        let count =
            usize::try_from(rela_size / RELA_ENTRY_SIZE as u64).map_err(|_| ElfError::RelaTable)?;
        if count > MAX_RELA_ENTRIES {
            return Err(ElfError::RelaTable);
        }
        let start = self.file_offset_for_range(rela_address, rela_size)?;
        let mut entries = Vec::with_capacity(count);
        for index in 0..count {
            let offset = start + index * RELA_ENTRY_SIZE;
            entries.push(Rela {
                offset: read_u64(self.bytes, offset)?,
                info: read_u64(self.bytes, offset + 8)?,
                addend: read_i64(self.bytes, offset + 16)?,
            });
        }
        Ok(entries)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Profile {
    pub name: &'static str,
    pub build_id: &'static [u8],
    pub sha256: [u8; 32],
    pub name_slot_rva: u64,
    pub binding_name_rva: u64,
    pub binding_name: &'static [u8],
    pub napi_callback_slot_rva: u64,
    pub napi_callback_rva: u64,
    pub napi_callback_fingerprint: &'static [u8],
    pub response_action_slot_rva: u64,
    pub response_action_rva: u64,
    pub response_action_fingerprint: &'static [u8],
    pub converter_rva: u64,
    pub converter_fingerprint: &'static [u8],
    pub resolve_action_rva: u64,
    pub resolve_action_fingerprint: &'static [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacketBindingProbe {
    pub module_base: usize,
    pub module_path: String,
    pub profile: &'static str,
    pub build_id: Vec<u8>,
    pub sha256: [u8; 32],
    pub name_slot_rva: u64,
    pub binding_name_rva: u64,
    pub binding_name: Vec<u8>,
    pub napi_callback_slot_rva: u64,
    pub napi_callback_rva: u64,
    pub napi_callback_fingerprint: Vec<u8>,
    pub response_action_slot_rva: u64,
    pub response_action_rva: u64,
    pub response_action_fingerprint: Vec<u8>,
    pub converter_rva: u64,
    pub converter_fingerprint: Vec<u8>,
    pub resolve_action_rva: u64,
    pub resolve_action_fingerprint: Vec<u8>,
}

pub fn verify_profile(
    image: &ElfImage<'_>,
    profile: Profile,
    name_value: u64,
    napi_callback_value: u64,
    response_action_value: u64,
    binding_name: &[u8],
    napi_callback_fingerprint: &[u8],
    response_action_fingerprint: &[u8],
    converter_fingerprint: &[u8],
    resolve_action_fingerprint: &[u8],
) -> Result<(), ElfError> {
    if image
        .load_for_range(profile.binding_name_rva, profile.binding_name.len() as u64)
        .is_none_or(|header| header.flags & (PF_R | PF_W | PF_X) != PF_R)
    {
        return Err(ElfError::BindingNamePermissions);
    }
    if image
        .load_for_range(
            profile.napi_callback_rva,
            profile.napi_callback_fingerprint.len() as u64,
        )
        .is_none_or(|header| header.flags & (PF_R | PF_W | PF_X) != (PF_R | PF_X))
    {
        return Err(ElfError::NapiCallbackPermissions);
    }
    if image
        .load_for_range(
            profile.response_action_rva,
            profile.response_action_fingerprint.len() as u64,
        )
        .is_none_or(|header| header.flags & (PF_R | PF_W | PF_X) != (PF_R | PF_X))
    {
        return Err(ElfError::ResponseActionPermissions);
    }
    if image
        .load_for_range(
            profile.converter_rva,
            profile.converter_fingerprint.len() as u64,
        )
        .is_none_or(|header| header.flags & (PF_R | PF_W | PF_X) != (PF_R | PF_X))
    {
        return Err(ElfError::ConverterPermissions);
    }
    if image
        .load_for_range(
            profile.resolve_action_rva,
            profile.resolve_action_fingerprint.len() as u64,
        )
        .is_none_or(|header| header.flags & (PF_R | PF_W | PF_X) != (PF_R | PF_X))
    {
        return Err(ElfError::ResolveActionPermissions);
    }
    if image
        .load_for_range(profile.name_slot_rva, std::mem::size_of::<u64>() as u64)
        .is_none_or(|header| header.flags & (PF_R | PF_W | PF_X) != (PF_R | PF_W))
    {
        return Err(ElfError::NameSlotPermissions);
    }
    if image
        .load_for_range(
            profile.napi_callback_slot_rva,
            std::mem::size_of::<u64>() as u64,
        )
        .is_none_or(|header| header.flags & (PF_R | PF_W | PF_X) != (PF_R | PF_W))
    {
        return Err(ElfError::NapiCallbackSlotPermissions);
    }
    if image
        .load_for_range(
            profile.response_action_slot_rva,
            std::mem::size_of::<u64>() as u64,
        )
        .is_none_or(|header| header.flags & (PF_R | PF_W | PF_X) != (PF_R | PF_W))
    {
        return Err(ElfError::ResponseActionSlotPermissions);
    }
    if binding_name != profile.binding_name {
        return Err(ElfError::BindingName);
    }
    if napi_callback_fingerprint != profile.napi_callback_fingerprint {
        return Err(ElfError::NapiCallbackFingerprint);
    }
    if response_action_fingerprint != profile.response_action_fingerprint {
        return Err(ElfError::ResponseActionFingerprint);
    }
    if converter_fingerprint != profile.converter_fingerprint {
        return Err(ElfError::ConverterFingerprint);
    }
    if resolve_action_fingerprint != profile.resolve_action_fingerprint {
        return Err(ElfError::ResolveActionFingerprint);
    }

    let relocations = image.rela_entries()?;
    let name_matches = relocations
        .iter()
        .filter(|rela| {
            rela.offset == profile.name_slot_rva
                && rela.info >> 32 == 0
                && rela.info as u32 == R_X86_64_RELATIVE
                && rela.addend == profile.binding_name_rva as i64
        })
        .count();
    if name_matches != 1 {
        return Err(ElfError::NameRela);
    }
    let napi_callback_matches = relocations
        .iter()
        .filter(|rela| {
            rela.offset == profile.napi_callback_slot_rva
                && rela.info >> 32 == 0
                && rela.info as u32 == R_X86_64_RELATIVE
                && rela.addend == profile.napi_callback_rva as i64
        })
        .count();
    if napi_callback_matches != 1 {
        return Err(ElfError::NapiCallbackRela);
    }
    let response_action_matches = relocations
        .iter()
        .filter(|rela| {
            rela.offset == profile.response_action_slot_rva
                && rela.info >> 32 == 0
                && rela.info as u32 == R_X86_64_RELATIVE
                && rela.addend == profile.response_action_rva as i64
        })
        .count();
    if response_action_matches != 1 {
        return Err(ElfError::ResponseActionRela);
    }
    if name_value != profile.binding_name_rva {
        return Err(ElfError::NameValue);
    }
    if napi_callback_value != profile.napi_callback_rva {
        return Err(ElfError::NapiCallbackValue);
    }
    if response_action_value != profile.response_action_rva {
        return Err(ElfError::ResponseActionValue);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn probe_packet_binding(profiles: &[Profile]) -> Result<PacketBindingProbe, ElfError> {
    let module = loaded_wrapper()?;
    let bytes = std::fs::read(&module.path).map_err(ElfError::ModuleRead)?;
    let image = ElfImage::parse(&bytes)?;
    let build_id = image.build_id()?;
    let sha256 = image.sha256();
    let profile = select_profile(profiles, &build_id, sha256)?;

    let name_slot = module
        .base
        .checked_add(usize::try_from(profile.name_slot_rva).map_err(|_| ElfError::NameValue)?)
        .ok_or(ElfError::NameValue)?;
    let napi_callback_slot = module
        .base
        .checked_add(
            usize::try_from(profile.napi_callback_slot_rva)
                .map_err(|_| ElfError::NapiCallbackValue)?,
        )
        .ok_or(ElfError::NapiCallbackValue)?;
    let response_action_slot = module
        .base
        .checked_add(
            usize::try_from(profile.response_action_slot_rva)
                .map_err(|_| ElfError::ResponseActionValue)?,
        )
        .ok_or(ElfError::ResponseActionValue)?;
    let binding_name_address = module
        .base
        .checked_add(usize::try_from(profile.binding_name_rva).map_err(|_| ElfError::BindingName)?)
        .ok_or(ElfError::BindingName)?;
    let napi_callback_address = module
        .base
        .checked_add(
            usize::try_from(profile.napi_callback_rva)
                .map_err(|_| ElfError::NapiCallbackFingerprint)?,
        )
        .ok_or(ElfError::NapiCallbackFingerprint)?;
    let response_action_address = module
        .base
        .checked_add(
            usize::try_from(profile.response_action_rva)
                .map_err(|_| ElfError::ResponseActionFingerprint)?,
        )
        .ok_or(ElfError::ResponseActionFingerprint)?;
    let converter_address = module
        .base
        .checked_add(
            usize::try_from(profile.converter_rva).map_err(|_| ElfError::ConverterFingerprint)?,
        )
        .ok_or(ElfError::ConverterFingerprint)?;
    let resolve_action_address = module
        .base
        .checked_add(
            usize::try_from(profile.resolve_action_rva)
                .map_err(|_| ElfError::ResolveActionFingerprint)?,
        )
        .ok_or(ElfError::ResolveActionFingerprint)?;

    let name_value = unsafe { (name_slot as *const u64).read_unaligned() }
        .checked_sub(module.base as u64)
        .ok_or(ElfError::NameValue)?;
    let napi_callback_value = unsafe { (napi_callback_slot as *const u64).read_unaligned() }
        .checked_sub(module.base as u64)
        .ok_or(ElfError::NapiCallbackValue)?;
    let response_action_value = unsafe { (response_action_slot as *const u64).read_unaligned() }
        .checked_sub(module.base as u64)
        .ok_or(ElfError::ResponseActionValue)?;
    let binding_name = unsafe {
        std::slice::from_raw_parts(
            binding_name_address as *const u8,
            profile.binding_name.len(),
        )
    };
    let napi_callback_fingerprint = unsafe {
        std::slice::from_raw_parts(
            napi_callback_address as *const u8,
            profile.napi_callback_fingerprint.len(),
        )
    };
    let response_action_fingerprint = unsafe {
        std::slice::from_raw_parts(
            response_action_address as *const u8,
            profile.response_action_fingerprint.len(),
        )
    };
    let converter_fingerprint = unsafe {
        std::slice::from_raw_parts(
            converter_address as *const u8,
            profile.converter_fingerprint.len(),
        )
    };
    let resolve_action_fingerprint = unsafe {
        std::slice::from_raw_parts(
            resolve_action_address as *const u8,
            profile.resolve_action_fingerprint.len(),
        )
    };
    verify_profile(
        &image,
        profile,
        name_value,
        napi_callback_value,
        response_action_value,
        binding_name,
        napi_callback_fingerprint,
        response_action_fingerprint,
        converter_fingerprint,
        resolve_action_fingerprint,
    )?;

    Ok(PacketBindingProbe {
        module_base: module.base,
        module_path: module.path,
        profile: profile.name,
        build_id,
        sha256,
        name_slot_rva: profile.name_slot_rva,
        binding_name_rva: profile.binding_name_rva,
        binding_name: profile.binding_name.to_vec(),
        napi_callback_slot_rva: profile.napi_callback_slot_rva,
        napi_callback_rva: profile.napi_callback_rva,
        napi_callback_fingerprint: profile.napi_callback_fingerprint.to_vec(),
        response_action_slot_rva: profile.response_action_slot_rva,
        response_action_rva: profile.response_action_rva,
        response_action_fingerprint: profile.response_action_fingerprint.to_vec(),
        converter_rva: profile.converter_rva,
        converter_fingerprint: profile.converter_fingerprint.to_vec(),
        resolve_action_rva: profile.resolve_action_rva,
        resolve_action_fingerprint: profile.resolve_action_fingerprint.to_vec(),
    })
}

#[cfg(not(target_os = "linux"))]
pub fn probe_packet_binding(_: &[Profile]) -> Result<PacketBindingProbe, ElfError> {
    Err(ElfError::ModuleNotLoaded)
}

#[cfg(target_os = "linux")]
struct LoadedModule {
    base: usize,
    path: String,
}

#[cfg(target_os = "linux")]
fn loaded_wrapper() -> Result<LoadedModule, ElfError> {
    unsafe extern "C" fn visit(
        info: *mut libc::dl_phdr_info,
        _: libc::size_t,
        data: *mut std::ffi::c_void,
    ) -> libc::c_int {
        let modules = unsafe { &mut *data.cast::<Vec<LoadedModule>>() };
        let info = unsafe { &*info };
        if info.dlpi_name.is_null() {
            return 0;
        }
        let path = unsafe { std::ffi::CStr::from_ptr(info.dlpi_name) };
        let Ok(path) = path.to_str() else {
            return 0;
        };
        if std::path::Path::new(path)
            .file_name()
            .is_some_and(|name| name == "wrapper.node")
        {
            modules.push(LoadedModule {
                base: info.dlpi_addr as usize,
                path: path.into(),
            });
        }
        0
    }

    let mut modules = Vec::new();
    unsafe {
        libc::dl_iterate_phdr(Some(visit), (&mut modules as *mut Vec<LoadedModule>).cast());
    }
    match modules.len() {
        0 => Err(ElfError::ModuleNotLoaded),
        1 => Ok(modules.pop().unwrap()),
        _ => Err(ElfError::ModuleAmbiguous),
    }
}

fn select_profile(
    profiles: &[Profile],
    build_id: &[u8],
    sha256: [u8; 32],
) -> Result<Profile, ElfError> {
    profiles
        .iter()
        .copied()
        .find(|profile| profile.build_id == build_id && profile.sha256 == sha256)
        .ok_or(ElfError::UnsupportedProfile)
}

fn dynamic_value(entries: &[DynamicEntry], tag: i64) -> Option<u64> {
    entries
        .iter()
        .find(|entry| entry.tag == tag)
        .map(|entry| entry.value)
}

fn align4(value: usize) -> Option<usize> {
    value.checked_add(3).map(|value| value & !3)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, ElfError> {
    Ok(u16::from_le_bytes(
        bytes
            .get(offset..offset + 2)
            .ok_or(ElfError::Truncated)?
            .try_into()
            .unwrap(),
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, ElfError> {
    Ok(u32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or(ElfError::Truncated)?
            .try_into()
            .unwrap(),
    ))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, ElfError> {
    Ok(u64::from_le_bytes(
        bytes
            .get(offset..offset + 8)
            .ok_or(ElfError::Truncated)?
            .try_into()
            .unwrap(),
    ))
}

fn read_i64(bytes: &[u8], offset: usize) -> Result<i64, ElfError> {
    Ok(i64::from_le_bytes(
        bytes
            .get(offset..offset + 8)
            .ok_or(ElfError::Truncated)?
            .try_into()
            .unwrap(),
    ))
}

pub fn hex(bytes: &[u8]) -> String {
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(value, "{byte:02x}");
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROFILE: Profile = Profile {
        name: "fixture",
        build_id: &[0xde, 0xad, 0xbe, 0xef],
        sha256: [0; 32],
        name_slot_rva: 0x430,
        binding_name_rva: 0x220,
        binding_name: b"fixtureBinding\0",
        napi_callback_slot_rva: 0x438,
        napi_callback_rva: 0x180,
        napi_callback_fingerprint: &[0x55, 0x48, 0x89, 0xe5],
        response_action_slot_rva: 0x440,
        response_action_rva: 0x190,
        response_action_fingerprint: &[0x41, 0x57, 0x41, 0x56],
        converter_rva: 0x1a0,
        converter_fingerprint: &[0x53, 0x48, 0x83, 0xec],
        resolve_action_rva: 0x1b0,
        resolve_action_fingerprint: &[0x41, 0x54, 0x53, 0x48],
    };

    fn write_u16(image: &mut [u8], offset: usize, value: u16) {
        image[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn write_u32(image: &mut [u8], offset: usize, value: u32) {
        image[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn write_u64(image: &mut [u8], offset: usize, value: u64) {
        image[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn write_i64(image: &mut [u8], offset: usize, value: i64) {
        image[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn write_program_header(
        image: &mut [u8],
        index: usize,
        kind: u32,
        flags: u32,
        offset: u64,
        address: u64,
        size: u64,
    ) {
        let header = 0x40 + index * PROGRAM_HEADER_SIZE;
        write_u32(image, header, kind);
        write_u32(image, header + 4, flags);
        write_u64(image, header + 8, offset);
        write_u64(image, header + 16, address);
        write_u64(image, header + 32, size);
        write_u64(image, header + 40, size);
        write_u64(image, header + 48, 0x1000);
    }

    fn image() -> Vec<u8> {
        let mut image = vec![0; 0x700];
        image[..4].copy_from_slice(b"\x7fELF");
        image[4..7].copy_from_slice(&[2, 1, 1]);
        write_u16(&mut image, 16, 3);
        write_u16(&mut image, 18, 62);
        write_u32(&mut image, 20, 1);
        write_u64(&mut image, 32, 0x40);
        write_u16(&mut image, 52, ELF_HEADER_SIZE as u16);
        write_u16(&mut image, 54, PROGRAM_HEADER_SIZE as u16);
        write_u16(&mut image, 56, 5);
        write_program_header(&mut image, 0, PT_LOAD, PF_X | PF_R, 0x180, 0x180, 0x80);
        write_program_header(&mut image, 1, PT_LOAD, PF_R, 0x200, 0x200, 0x100);
        write_program_header(&mut image, 2, PT_LOAD, PF_W | PF_R, 0x400, 0x400, 0x300);
        write_program_header(&mut image, 3, PT_NOTE, 0, 0x300, 0, 0x20);
        write_program_header(&mut image, 4, PT_DYNAMIC, 0, 0x500, 0x500, 0x40);

        write_u32(&mut image, 0x300, 4);
        write_u32(&mut image, 0x304, 4);
        write_u32(&mut image, 0x308, 3);
        image[0x30c..0x310].copy_from_slice(b"GNU\0");
        image[0x310..0x314].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);

        image[0x220..0x220 + PROFILE.binding_name.len()].copy_from_slice(PROFILE.binding_name);
        image[0x180..0x184].copy_from_slice(PROFILE.napi_callback_fingerprint);
        image[0x190..0x194].copy_from_slice(PROFILE.response_action_fingerprint);
        image[0x1a0..0x1a4].copy_from_slice(PROFILE.converter_fingerprint);
        image[0x1b0..0x1b4].copy_from_slice(PROFILE.resolve_action_fingerprint);
        write_i64(&mut image, 0x500, DT_RELA);
        write_u64(&mut image, 0x508, 0x580);
        write_i64(&mut image, 0x510, DT_RELASZ);
        write_u64(&mut image, 0x518, 3 * RELA_ENTRY_SIZE as u64);
        write_i64(&mut image, 0x520, DT_RELAENT);
        write_u64(&mut image, 0x528, RELA_ENTRY_SIZE as u64);
        for (index, (slot, target)) in [
            (PROFILE.name_slot_rva, PROFILE.binding_name_rva),
            (PROFILE.napi_callback_slot_rva, PROFILE.napi_callback_rva),
            (
                PROFILE.response_action_slot_rva,
                PROFILE.response_action_rva,
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let offset = 0x580 + index * RELA_ENTRY_SIZE;
            write_u64(&mut image, offset, slot);
            write_u64(&mut image, offset + 8, R_X86_64_RELATIVE as u64);
            write_i64(&mut image, offset + 16, target as i64);
        }
        image
    }

    fn verify(image: &[u8], profile: Profile) -> Result<(), ElfError> {
        let elf = ElfImage::parse(image)?;
        verify_profile(
            &elf,
            profile,
            profile.binding_name_rva,
            profile.napi_callback_rva,
            profile.response_action_rva,
            profile.binding_name,
            profile.napi_callback_fingerprint,
            profile.response_action_fingerprint,
            profile.converter_fingerprint,
            profile.resolve_action_fingerprint,
        )
    }

    #[test]
    fn parses_build_id_hash_and_validates_all_packet_targets() {
        let image = image();
        let elf = ElfImage::parse(&image).unwrap();
        assert_eq!(elf.build_id().unwrap(), PROFILE.build_id);
        assert_eq!(
            hex(&elf.sha256()),
            "425112219668ce8340cc46b81b328dd2e1525335b6fe7d0c52108d3f60f55fe0"
        );
        verify(&image, PROFILE).unwrap();
    }

    #[test]
    fn rejects_unknown_profile_identity() {
        assert!(matches!(
            select_profile(&[PROFILE], &[0; 8], [0; 32]),
            Err(ElfError::UnsupportedProfile)
        ));
    }

    #[test]
    fn rejects_invalid_name_callback_and_response_relocations() {
        for (index, error) in [
            (0, ElfError::NameRela),
            (1, ElfError::NapiCallbackRela),
            (2, ElfError::ResponseActionRela),
        ] {
            let mut image = image();
            write_u64(&mut image, 0x580 + index * RELA_ENTRY_SIZE + 8, 1);
            assert!(
                matches!(verify(&image, PROFILE), Err(actual) if std::mem::discriminant(&actual) == std::mem::discriminant(&error))
            );
        }
    }

    #[test]
    fn rejects_mismatched_loaded_slot_values() {
        let image = image();
        let elf = ElfImage::parse(&image).unwrap();
        assert!(matches!(
            verify_profile(
                &elf,
                PROFILE,
                PROFILE.binding_name_rva,
                PROFILE.napi_callback_rva + 1,
                PROFILE.response_action_rva,
                PROFILE.binding_name,
                PROFILE.napi_callback_fingerprint,
                PROFILE.response_action_fingerprint,
                PROFILE.converter_fingerprint,
                PROFILE.resolve_action_fingerprint,
            ),
            Err(ElfError::NapiCallbackValue)
        ));
    }

    #[test]
    fn rejects_invalid_target_and_slot_permissions() {
        let image = image();
        let mut target_profile = PROFILE;
        target_profile.converter_rva = PROFILE.name_slot_rva;
        assert!(matches!(
            verify(&image, target_profile),
            Err(ElfError::ConverterPermissions)
        ));
        let mut slot_profile = PROFILE;
        slot_profile.response_action_slot_rva = PROFILE.binding_name_rva;
        assert!(matches!(
            verify(&image, slot_profile),
            Err(ElfError::ResponseActionSlotPermissions)
        ));
    }

    #[test]
    fn rejects_mismatched_name_and_code_fingerprints() {
        let image = image();
        let elf = ElfImage::parse(&image).unwrap();
        assert!(matches!(
            verify_profile(
                &elf,
                PROFILE,
                PROFILE.binding_name_rva,
                PROFILE.napi_callback_rva,
                PROFILE.response_action_rva,
                b"wrongBinding\0",
                PROFILE.napi_callback_fingerprint,
                PROFILE.response_action_fingerprint,
                PROFILE.converter_fingerprint,
                PROFILE.resolve_action_fingerprint,
            ),
            Err(ElfError::BindingName)
        ));
        assert!(matches!(
            verify_profile(
                &elf,
                PROFILE,
                PROFILE.binding_name_rva,
                PROFILE.napi_callback_rva,
                PROFILE.response_action_rva,
                PROFILE.binding_name,
                PROFILE.napi_callback_fingerprint,
                PROFILE.response_action_fingerprint,
                &[0; 4],
                PROFILE.resolve_action_fingerprint,
            ),
            Err(ElfError::ConverterFingerprint)
        ));
    }

    #[test]
    fn accepts_current_sized_rela_tables_and_rejects_the_cap() {
        let count = 65_537usize;
        let mut large = image();
        let end = 0x580 + count * RELA_ENTRY_SIZE;
        large.resize(end, 0);
        write_program_header(
            &mut large,
            2,
            PT_LOAD,
            PF_W | PF_R,
            0x400,
            0x400,
            (end - 0x400) as u64,
        );
        write_u64(&mut large, 0x518, (count * RELA_ENTRY_SIZE) as u64);
        assert_eq!(
            ElfImage::parse(&large)
                .unwrap()
                .rela_entries()
                .unwrap()
                .len(),
            count
        );

        let mut oversized = image();
        write_u64(
            &mut oversized,
            0x518,
            ((MAX_RELA_ENTRIES + 1) * RELA_ENTRY_SIZE) as u64,
        );
        assert!(matches!(
            ElfImage::parse(&oversized).unwrap().rela_entries(),
            Err(ElfError::RelaTable)
        ));
    }

    #[test]
    fn rejects_invalid_elf_header() {
        assert!(matches!(
            ElfImage::parse(b"not an ELF image"),
            Err(ElfError::Truncated)
        ));
    }
}
