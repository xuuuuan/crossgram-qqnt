#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

#[cfg(target_os = "linux")]
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

const ELF_HEADER_SIZE: usize = 64;
const PROGRAM_HEADER_SIZE: usize = 56;
const DYNAMIC_ENTRY_SIZE: usize = 16;
const RELA_ENTRY_SIZE: usize = 24;
const MAX_PROGRAM_HEADERS: usize = 128;
const MAX_DYNAMIC_ENTRIES: usize = 4096;
const MAX_RELA_ENTRIES: usize = 1_000_000;
const MAX_UNWIND_FUNCTIONS: usize = 1_000_000;
const MAX_FUNCTION_SIZE: u64 = 1024 * 1024;
#[cfg(target_os = "linux")]
const VERIFY_PREFIX_SIZE: usize = 16;

const PT_LOAD: u32 = 1;
const PT_DYNAMIC: u32 = 2;
const PT_NOTE: u32 = 4;
const PT_GNU_EH_FRAME: u32 = 0x6474_e550;
const PF_X: u32 = 1;
const PF_W: u32 = 2;
const PF_R: u32 = 4;
const DT_NULL: i64 = 0;
const DT_RELA: i64 = 7;
const DT_RELASZ: i64 = 8;
const DT_RELAENT: i64 = 9;
const R_X86_64_RELATIVE: u32 = 8;

const DW_EH_PE_OMIT: u8 = 0xff;
const DW_EH_PE_ABSPTR: u8 = 0x00;
const DW_EH_PE_ULEB128: u8 = 0x01;
const DW_EH_PE_UDATA2: u8 = 0x02;
const DW_EH_PE_UDATA4: u8 = 0x03;
const DW_EH_PE_UDATA8: u8 = 0x04;
const DW_EH_PE_SLEB128: u8 = 0x09;
const DW_EH_PE_SDATA2: u8 = 0x0a;
const DW_EH_PE_SDATA4: u8 = 0x0b;
const DW_EH_PE_SDATA8: u8 = 0x0c;
const DW_EH_PE_PCREL: u8 = 0x10;
const DW_EH_PE_DATAREL: u8 = 0x30;
const DW_EH_PE_INDIRECT: u8 = 0x80;

#[cfg(target_os = "linux")]
const LOCATOR_NAME: &str = "linux-xref-v1";
const RESPONSE_ANCHORS: [(&str, &[u8]); 3] = [
    ("result", b"result\0"),
    ("errMsg", b"errMsg\0"),
    ("rsp", b"rsp\0"),
];
const RECEIVE_ANCHOR: &[u8] = b"MSF recv seq:{} cmd:{} data_size:{}, error_code:{}\0";
const RECEIVE_PROLOGUE: &[u8] = b"\x55\x41\x57\x41\x56";

#[derive(Debug, Error)]
pub enum ElfError {
    #[error("wrapper.node is not loaded in this process")]
    ModuleNotLoaded,
    #[cfg(target_os = "linux")]
    #[error("multiple wrapper.node modules are loaded in this process")]
    ModuleAmbiguous,
    #[cfg(target_os = "linux")]
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
    #[error("ELF GNU unwind lookup table is missing or invalid")]
    UnwindTable,
    #[error("ELF GNU unwind pointer encoding is unsupported")]
    UnwindEncoding,
    #[error("ELF dynamic RELA table is missing or invalid")]
    RelaTable,
    #[error("QQNT send assertion did not produce exactly one non-executable string match")]
    SendAnchorScan,
    #[error("QQNT send assertion did not produce exactly one executable RIP-relative XRef")]
    SendAnchorXref,
    #[error("QQNT send assertion XRef is not covered by the GNU unwind table")]
    NapiCallbackScan,
    #[error("QQNT send wrapper did not contain one validated repeated converter call target")]
    ConverterScan,
    #[error("QQNT response property XRefs did not identify exactly one Promise resolver")]
    ResolverScan,
    #[error("located QQNT code or data has invalid ELF segment permissions")]
    LocatorPermissions,
    #[cfg(target_os = "linux")]
    #[error("loaded QQNT {0} bytes differ from the wrapper.node parsed on disk")]
    LoadedImageMismatch(&'static str),
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
struct FunctionRange {
    begin: u64,
    end: u64,
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
        let program_end = program_count
            .checked_mul(PROGRAM_HEADER_SIZE)
            .and_then(|size| program_offset.checked_add(size))
            .filter(|end| *end <= bytes.len())
            .ok_or(ElfError::Truncated)?;
        let _ = program_end;

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

    #[cfg(target_os = "linux")]
    pub fn sha256(&self) -> [u8; 32] {
        Sha256::digest(self.bytes).into()
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
        offset
            .checked_add(usize::try_from(length).map_err(|_| ElfError::VirtualAddress)?)
            .filter(|end| *end <= self.bytes.len())
            .ok_or(ElfError::VirtualAddress)?;
        Ok(offset)
    }

    fn bytes_at(&self, address: u64, length: usize) -> Result<&'a [u8], ElfError> {
        let offset = self.file_offset_for_range(
            address,
            u64::try_from(length).map_err(|_| ElfError::VirtualAddress)?,
        )?;
        let end = offset.checked_add(length).ok_or(ElfError::VirtualAddress)?;
        self.bytes.get(offset..end).ok_or(ElfError::VirtualAddress)
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
        let start = usize::try_from(header.offset).map_err(|_| ElfError::RelaTable)?;
        let end = count
            .checked_mul(DYNAMIC_ENTRY_SIZE)
            .and_then(|size| start.checked_add(size))
            .filter(|end| *end <= self.bytes.len())
            .ok_or(ElfError::RelaTable)?;
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

    fn non_executable_matches(&self, needle: &[u8]) -> Vec<u64> {
        if needle.is_empty() {
            return Vec::new();
        }
        let mut matches = Vec::new();
        for header in self.program_headers.iter().filter(|header| {
            header.kind == PT_LOAD && header.flags & PF_R != 0 && header.flags & PF_X == 0
        }) {
            let Ok(start) = usize::try_from(header.offset) else {
                continue;
            };
            let Some(end) = usize::try_from(header.file_size)
                .ok()
                .and_then(|size| start.checked_add(size))
                .filter(|end| *end <= self.bytes.len())
            else {
                continue;
            };
            for (relative, bytes) in self.bytes[start..end].windows(needle.len()).enumerate() {
                if bytes == needle {
                    if let Some(address) = header
                        .virtual_address
                        .checked_add(u64::try_from(relative).unwrap_or(u64::MAX))
                    {
                        matches.push(address);
                    }
                }
            }
        }
        matches
    }

    fn rip_relative_xrefs_for_targets(&self, targets: &BTreeSet<u64>) -> BTreeMap<u64, Vec<u64>> {
        let mut xrefs: BTreeMap<u64, Vec<u64>> = BTreeMap::new();
        if targets.is_empty() {
            return xrefs;
        }
        for header in self.program_headers.iter().filter(|header| {
            header.kind == PT_LOAD && header.flags & (PF_R | PF_W | PF_X) == (PF_R | PF_X)
        }) {
            let Ok(start) = usize::try_from(header.offset) else {
                continue;
            };
            let Some(end) = usize::try_from(header.file_size)
                .ok()
                .and_then(|size| start.checked_add(size))
                .filter(|end| *end <= self.bytes.len())
            else {
                continue;
            };
            for (relative, instruction) in self.bytes[start..end].windows(7).enumerate() {
                if !(0x48..=0x4f).contains(&instruction[0])
                    || instruction[1] != 0x8d
                    || instruction[2] & 0xc7 != 0x05
                {
                    continue;
                }
                let instruction_rva = match header
                    .virtual_address
                    .checked_add(u64::try_from(relative).unwrap_or(u64::MAX))
                {
                    Some(value) => value,
                    None => continue,
                };
                let displacement =
                    i32::from_le_bytes(instruction[3..7].try_into().unwrap()) as i128;
                let resolved = instruction_rva as i128 + 7 + displacement;
                if resolved < 0 {
                    continue;
                }
                let resolved = resolved as u64;
                if targets.contains(&resolved) {
                    xrefs.entry(resolved).or_default().push(instruction_rva);
                }
            }
        }
        xrefs
    }

    fn direct_calls(&self, function: FunctionRange) -> Vec<(u64, u64)> {
        let function_size = function.end.saturating_sub(function.begin);
        if function_size > MAX_FUNCTION_SIZE {
            return Vec::new();
        }
        let Ok(length) = usize::try_from(function_size) else {
            return Vec::new();
        };
        let Ok(bytes) = self.bytes_at(function.begin, length) else {
            return Vec::new();
        };
        bytes
            .windows(5)
            .enumerate()
            .filter_map(|(relative, instruction)| {
                if instruction[0] != 0xe8 {
                    return None;
                }
                let call = function.begin.checked_add(u64::try_from(relative).ok()?)?;
                let displacement = i32::from_le_bytes(instruction[1..5].try_into().ok()?) as i128;
                let target = call as i128 + 5 + displacement;
                (target >= 0).then_some((call, target as u64))
            })
            .collect()
    }

    fn rip_relative_lea_targets(&self, function: FunctionRange) -> Vec<(u64, u64)> {
        let function_size = function.end.saturating_sub(function.begin);
        if function_size > MAX_FUNCTION_SIZE {
            return Vec::new();
        }
        let Ok(length) = usize::try_from(function_size) else {
            return Vec::new();
        };
        let Ok(bytes) = self.bytes_at(function.begin, length) else {
            return Vec::new();
        };
        bytes
            .windows(7)
            .enumerate()
            .filter_map(|(relative, instruction)| {
                if !(0x48..=0x4f).contains(&instruction[0])
                    || instruction[1] != 0x8d
                    || instruction[2] & 0xc7 != 0x05
                {
                    return None;
                }
                let xref = function.begin.checked_add(u64::try_from(relative).ok()?)?;
                let displacement = i32::from_le_bytes(instruction[3..7].try_into().ok()?) as i128;
                let target = xref as i128 + 7 + displacement;
                (target >= 0).then_some((xref, target as u64))
            })
            .collect()
    }

    fn unwind_functions(&self) -> Result<Vec<FunctionRange>, ElfError> {
        let headers: Vec<_> = self
            .program_headers
            .iter()
            .copied()
            .filter(|header| header.kind == PT_GNU_EH_FRAME)
            .collect();
        if headers.len() != 1 {
            return Err(ElfError::UnwindTable);
        }
        let header = headers[0];
        let start = usize::try_from(header.offset).map_err(|_| ElfError::UnwindTable)?;
        let size = usize::try_from(header.file_size).map_err(|_| ElfError::UnwindTable)?;
        let end = start
            .checked_add(size)
            .filter(|end| *end <= self.bytes.len())
            .ok_or(ElfError::UnwindTable)?;
        let bytes = self.bytes.get(start..end).ok_or(ElfError::UnwindTable)?;
        if bytes.len() < 4 || bytes[0] != 1 {
            return Err(ElfError::UnwindTable);
        }

        let mut cursor = 4usize;
        let _eh_frame = decode_eh_pointer(
            bytes,
            &mut cursor,
            bytes[1],
            header.virtual_address,
            header.virtual_address,
        )?;
        let count = decode_eh_pointer(
            bytes,
            &mut cursor,
            bytes[2],
            header.virtual_address,
            header.virtual_address,
        )?;
        let count = usize::try_from(count).map_err(|_| ElfError::UnwindTable)?;
        if count == 0 || count > MAX_UNWIND_FUNCTIONS || bytes[3] == DW_EH_PE_OMIT {
            return Err(ElfError::UnwindTable);
        }

        let mut starts = Vec::with_capacity(count);
        for _ in 0..count {
            let begin = decode_eh_pointer(
                bytes,
                &mut cursor,
                bytes[3],
                header.virtual_address,
                header.virtual_address,
            )?;
            let _fde = decode_eh_pointer(
                bytes,
                &mut cursor,
                bytes[3],
                header.virtual_address,
                header.virtual_address,
            )?;
            if self
                .load_for_range(begin, 1)
                .is_none_or(|load| load.flags & (PF_R | PF_W | PF_X) != (PF_R | PF_X))
                || starts.last().is_some_and(|previous| *previous >= begin)
            {
                return Err(ElfError::UnwindTable);
            }
            starts.push(begin);
        }

        let mut functions = Vec::with_capacity(starts.len());
        for (index, begin) in starts.iter().copied().enumerate() {
            let load = self.load_for_range(begin, 1).ok_or(ElfError::UnwindTable)?;
            let load_end = load
                .virtual_address
                .checked_add(load.file_size)
                .ok_or(ElfError::UnwindTable)?;
            let next = starts.get(index + 1).copied().unwrap_or(load_end);
            let end = if next <= load_end { next } else { load_end };
            if end <= begin {
                return Err(ElfError::UnwindTable);
            }
            functions.push(FunctionRange { begin, end });
        }
        Ok(functions)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocatedPacketBinding {
    receive_rva: u64,
    anchor_rva: u64,
    anchor_xref_rva: u64,
    napi_callback_rva: u64,
    converter_rva: u64,
    result_anchor_rva: u64,
    result_xref_rva: u64,
    err_msg_anchor_rva: u64,
    err_msg_xref_rva: u64,
    rsp_anchor_rva: u64,
    rsp_xref_rva: u64,
    response_table_xref_rva: u64,
    response_table_rva: u64,
    response_action_slot_rva: u64,
    response_action_rva: u64,
    dispatch_helper_rva: u64,
    resolver_thunk_rva: u64,
    resolve_action_rva: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacketBindingProbe {
    pub receive_rva: u64,
    pub module_base: usize,
    pub module_path: String,
    pub locator: &'static str,
    pub build_id: Vec<u8>,
    pub sha256: [u8; 32],
    pub anchor_rva: u64,
    pub anchor_xref_rva: u64,
    pub napi_callback_rva: u64,
    pub converter_rva: u64,
    pub result_anchor_rva: u64,
    pub result_xref_rva: u64,
    pub err_msg_anchor_rva: u64,
    pub err_msg_xref_rva: u64,
    pub rsp_anchor_rva: u64,
    pub rsp_xref_rva: u64,
    pub response_table_xref_rva: u64,
    pub response_table_rva: u64,
    pub response_action_slot_rva: u64,
    pub response_action_rva: u64,
    pub dispatch_helper_rva: u64,
    pub resolver_thunk_rva: u64,
    pub resolve_action_rva: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct ResponseChain {
    response_table_xref_rva: u64,
    response_table_rva: u64,
    response_action_slot_rva: u64,
    response_action_rva: u64,
    dispatch_helper_rva: u64,
    resolver_thunk_rva: u64,
    resolve_action_rva: u64,
}

fn locate_packet_binding(
    image: &ElfImage<'_>,
    send_anchor: &[u8],
) -> Result<LocatedPacketBinding, ElfError> {
    let functions = image.unwind_functions()?;
    let anchor_rva =
        unique(image.non_executable_matches(send_anchor)).ok_or(ElfError::SendAnchorScan)?;
    let response_anchor_matches: Vec<Vec<u64>> = RESPONSE_ANCHORS
        .iter()
        .map(|(_, anchor)| image.non_executable_matches(anchor))
        .collect();
    let mut xref_targets = BTreeSet::new();
    xref_targets.insert(anchor_rva);
    for matches in &response_anchor_matches {
        xref_targets.extend(matches.iter().copied());
    }
    let xrefs = image.rip_relative_xrefs_for_targets(&xref_targets);
    let anchor_xref_rva = unique(xrefs.get(&anchor_rva).cloned().unwrap_or_default())
        .ok_or(ElfError::SendAnchorXref)?;
    let napi_callback =
        function_containing(&functions, anchor_xref_rva).ok_or(ElfError::NapiCallbackScan)?;

    let calls = image.direct_calls(napi_callback);
    let mut converters = BTreeSet::new();
    for pair in calls.windows(2) {
        let (first_call, first_target) = pair[0];
        let (second_call, second_target) = pair[1];
        if first_target == second_target
            && (8..=32).contains(&second_call.saturating_sub(first_call))
            && function_starting(&functions, first_target).is_some()
        {
            converters.insert(first_target);
        }
    }
    let converter_rva = unique(converters.into_iter().collect()).ok_or(ElfError::ConverterScan)?;

    let mut response_xrefs: Vec<BTreeMap<u64, Vec<(u64, u64)>>> = Vec::new();
    for anchor_matches in response_anchor_matches {
        let mut by_function: BTreeMap<u64, Vec<(u64, u64)>> = BTreeMap::new();
        for anchor_rva in anchor_matches {
            for xref_rva in xrefs.get(&anchor_rva).into_iter().flatten().copied() {
                if let Some(function) = function_containing(&functions, xref_rva) {
                    by_function
                        .entry(function.begin)
                        .or_default()
                        .push((anchor_rva, xref_rva));
                }
            }
        }
        response_xrefs.push(by_function);
    }

    let mut resolver_candidates: BTreeSet<u64> = response_xrefs
        .first()
        .map(|matches| matches.keys().copied().collect())
        .unwrap_or_default();
    for matches in response_xrefs.iter().skip(1) {
        resolver_candidates.retain(|function| matches.contains_key(function));
    }
    let chain = locate_response_chain(image, &functions, napi_callback, &resolver_candidates)?;
    let resolve_action_rva = chain.resolve_action_rva;
    let selected: Vec<(u64, u64)> = response_xrefs
        .iter()
        .map(|matches| {
            matches
                .get(&resolve_action_rva)
                .and_then(|values| unique(values.clone()))
                .ok_or(ElfError::ResolverScan)
        })
        .collect::<Result<_, _>>()?;

    let located = LocatedPacketBinding {
        receive_rva: locate_receive_function(image, &functions),
        anchor_rva,
        anchor_xref_rva,
        napi_callback_rva: napi_callback.begin,
        converter_rva,
        result_anchor_rva: selected[0].0,
        result_xref_rva: selected[0].1,
        err_msg_anchor_rva: selected[1].0,
        err_msg_xref_rva: selected[1].1,
        rsp_anchor_rva: selected[2].0,
        rsp_xref_rva: selected[2].1,
        response_table_xref_rva: chain.response_table_xref_rva,
        response_table_rva: chain.response_table_rva,
        response_action_slot_rva: chain.response_action_slot_rva,
        response_action_rva: chain.response_action_rva,
        dispatch_helper_rva: chain.dispatch_helper_rva,
        resolver_thunk_rva: chain.resolver_thunk_rva,
        resolve_action_rva,
    };
    verify_locator_permissions(image, &located, send_anchor)?;
    Ok(located)
}

fn locate_receive_function(image: &ElfImage<'_>, functions: &[FunctionRange]) -> u64 {
    let Some(anchor_rva) = unique(image.non_executable_matches(RECEIVE_ANCHOR)) else {
        return 0;
    };
    let xrefs = image.rip_relative_xrefs_for_targets(&BTreeSet::from([anchor_rva]));
    let Some(xref_rva) = unique(xrefs.get(&anchor_rva).cloned().unwrap_or_default()) else {
        return 0;
    };
    let Some(function) = function_containing(functions, xref_rva) else {
        return 0;
    };
    (image.bytes_at(function.begin, RECEIVE_PROLOGUE.len()).ok() == Some(RECEIVE_PROLOGUE))
        .then_some(function.begin)
        .unwrap_or(0)
}

fn locate_response_chain(
    image: &ElfImage<'_>,
    functions: &[FunctionRange],
    napi_callback: FunctionRange,
    resolver_candidates: &BTreeSet<u64>,
) -> Result<ResponseChain, ElfError> {
    if resolver_candidates.is_empty() {
        return Err(ElfError::ResolverScan);
    }
    let relocations = image.rela_entries()?;
    let mut chains = BTreeSet::new();
    for (table_xref, table_rva) in image.rip_relative_lea_targets(napi_callback) {
        if image
            .load_for_range(table_rva, 1)
            .is_none_or(|load| load.flags & PF_R == 0 || load.flags & PF_X != 0)
        {
            continue;
        }
        let table_end = table_rva.saturating_add(0x80);
        for relocation in relocations.iter().filter(|relocation| {
            relocation.offset >= table_rva
                && relocation.offset < table_end
                && relocation.info >> 32 == 0
                && relocation.info as u32 == R_X86_64_RELATIVE
                && relocation.addend >= 0
        }) {
            let response_action_rva = relocation.addend as u64;
            let Some(response_action) = function_starting(functions, response_action_rva) else {
                continue;
            };
            for (_, dispatch_helper_rva) in image.direct_calls(response_action) {
                let Some(dispatch_helper) = function_starting(functions, dispatch_helper_rva)
                else {
                    continue;
                };
                for (_, resolver_thunk_rva) in image.rip_relative_lea_targets(dispatch_helper) {
                    let Some(resolver_thunk) = function_starting(functions, resolver_thunk_rva)
                    else {
                        continue;
                    };
                    for (_, resolve_action_rva) in image.direct_calls(resolver_thunk) {
                        if resolver_candidates.contains(&resolve_action_rva) {
                            chains.insert(ResponseChain {
                                response_table_xref_rva: table_xref,
                                response_table_rva: table_rva,
                                response_action_slot_rva: relocation.offset,
                                response_action_rva,
                                dispatch_helper_rva,
                                resolver_thunk_rva,
                                resolve_action_rva,
                            });
                        }
                    }
                }
            }
        }
    }
    unique(chains.into_iter().collect()).ok_or(ElfError::ResolverScan)
}

fn verify_locator_permissions(
    image: &ElfImage<'_>,
    located: &LocatedPacketBinding,
    send_anchor: &[u8],
) -> Result<(), ElfError> {
    for (address, length) in [
        (located.anchor_rva, send_anchor.len()),
        (located.result_anchor_rva, RESPONSE_ANCHORS[0].1.len()),
        (located.err_msg_anchor_rva, RESPONSE_ANCHORS[1].1.len()),
        (located.rsp_anchor_rva, RESPONSE_ANCHORS[2].1.len()),
    ] {
        if image
            .load_for_range(address, length as u64)
            .is_none_or(|header| header.flags & PF_R == 0 || header.flags & PF_X != 0)
        {
            return Err(ElfError::LocatorPermissions);
        }
    }
    if located.receive_rva != 0 {
        for (address, length) in [(located.receive_rva, 1usize)] {
            if image
                .load_for_range(address, length as u64)
                .is_none_or(|header| header.flags & (PF_R | PF_W | PF_X) != (PF_R | PF_X))
            {
                return Err(ElfError::LocatorPermissions);
            }
        }
    }
    for address in [
        located.anchor_xref_rva,
        located.napi_callback_rva,
        located.converter_rva,
        located.result_xref_rva,
        located.err_msg_xref_rva,
        located.rsp_xref_rva,
        located.response_table_xref_rva,
        located.response_action_rva,
        located.dispatch_helper_rva,
        located.resolver_thunk_rva,
        located.resolve_action_rva,
    ] {
        if image
            .load_for_range(address, 1)
            .is_none_or(|header| header.flags & (PF_R | PF_W | PF_X) != (PF_R | PF_X))
        {
            return Err(ElfError::LocatorPermissions);
        }
    }
    if image
        .load_for_range(located.response_action_slot_rva, 8)
        .is_none_or(|header| header.flags & PF_R == 0 || header.flags & PF_X != 0)
    {
        return Err(ElfError::LocatorPermissions);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn probe_packet_binding(send_anchor: &[u8]) -> Result<PacketBindingProbe, ElfError> {
    let module = loaded_wrapper()?;
    let bytes = std::fs::read(&module.path).map_err(ElfError::ModuleRead)?;
    let image = ElfImage::parse(&bytes)?;
    let located = locate_packet_binding(&image, send_anchor)?;

    verify_loaded_bytes(
        &image,
        module.base,
        located.anchor_rva,
        send_anchor,
        "anchor",
    )?;
    if located.receive_rva != 0 {
        let expected = image.bytes_at(located.receive_rva, RECEIVE_PROLOGUE.len())?;
        verify_loaded_bytes(
            &image,
            module.base,
            located.receive_rva,
            expected,
            "receive",
        )?;
    }
    for (name, address, length) in [
        ("anchor XRef", located.anchor_xref_rva, 7usize),
        (
            "N-API callback",
            located.napi_callback_rva,
            VERIFY_PREFIX_SIZE,
        ),
        ("converter", located.converter_rva, VERIFY_PREFIX_SIZE),
        ("result XRef", located.result_xref_rva, 7usize),
        ("errMsg XRef", located.err_msg_xref_rva, 7usize),
        ("rsp XRef", located.rsp_xref_rva, 7usize),
        (
            "response table XRef",
            located.response_table_xref_rva,
            7usize,
        ),
        (
            "response action",
            located.response_action_rva,
            VERIFY_PREFIX_SIZE,
        ),
        (
            "dispatch helper",
            located.dispatch_helper_rva,
            VERIFY_PREFIX_SIZE,
        ),
        (
            "resolver thunk",
            located.resolver_thunk_rva,
            VERIFY_PREFIX_SIZE,
        ),
        (
            "Promise resolver",
            located.resolve_action_rva,
            VERIFY_PREFIX_SIZE,
        ),
    ] {
        let expected = image.bytes_at(address, length)?;
        verify_loaded_bytes(&image, module.base, address, expected, name)?;
    }

    Ok(PacketBindingProbe {
        module_base: module.base,
        module_path: module.path,
        locator: LOCATOR_NAME,
        build_id: image.build_id().unwrap_or_default(),
        sha256: image.sha256(),
        anchor_rva: located.anchor_rva,
        anchor_xref_rva: located.anchor_xref_rva,
        napi_callback_rva: located.napi_callback_rva,
        converter_rva: located.converter_rva,
        result_anchor_rva: located.result_anchor_rva,
        result_xref_rva: located.result_xref_rva,
        err_msg_anchor_rva: located.err_msg_anchor_rva,
        err_msg_xref_rva: located.err_msg_xref_rva,
        rsp_anchor_rva: located.rsp_anchor_rva,
        rsp_xref_rva: located.rsp_xref_rva,
        response_table_xref_rva: located.response_table_xref_rva,
        response_table_rva: located.response_table_rva,
        response_action_slot_rva: located.response_action_slot_rva,
        response_action_rva: located.response_action_rva,
        dispatch_helper_rva: located.dispatch_helper_rva,
        resolver_thunk_rva: located.resolver_thunk_rva,
        resolve_action_rva: located.resolve_action_rva,
        receive_rva: located.receive_rva,
    })
}

#[cfg(not(target_os = "linux"))]
pub fn probe_packet_binding(_: &[u8]) -> Result<PacketBindingProbe, ElfError> {
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

#[cfg(target_os = "linux")]
fn verify_loaded_bytes(
    image: &ElfImage<'_>,
    module_base: usize,
    address: u64,
    expected: &[u8],
    name: &'static str,
) -> Result<(), ElfError> {
    image.bytes_at(address, expected.len())?;
    let loaded = module_base
        .checked_add(usize::try_from(address).map_err(|_| ElfError::LoadedImageMismatch(name))?)
        .ok_or(ElfError::LoadedImageMismatch(name))?;
    let actual = unsafe { std::slice::from_raw_parts(loaded as *const u8, expected.len()) };
    if actual != expected {
        return Err(ElfError::LoadedImageMismatch(name));
    }
    Ok(())
}

fn function_containing(functions: &[FunctionRange], address: u64) -> Option<FunctionRange> {
    let index = functions.partition_point(|function| function.begin <= address);
    let function = *functions.get(index.checked_sub(1)?)?;
    (address < function.end && function.end - function.begin <= MAX_FUNCTION_SIZE)
        .then_some(function)
}

fn function_starting(functions: &[FunctionRange], address: u64) -> Option<FunctionRange> {
    functions
        .binary_search_by_key(&address, |function| function.begin)
        .ok()
        .and_then(|index| functions.get(index).copied())
}

fn unique<T>(values: Vec<T>) -> Option<T> {
    let mut values = values.into_iter();
    let value = values.next()?;
    values.next().is_none().then_some(value)
}

fn dynamic_value(entries: &[DynamicEntry], tag: i64) -> Option<u64> {
    entries
        .iter()
        .find(|entry| entry.tag == tag)
        .map(|entry| entry.value)
}

fn decode_eh_pointer(
    bytes: &[u8],
    cursor: &mut usize,
    encoding: u8,
    datarel_base: u64,
    section_address: u64,
) -> Result<u64, ElfError> {
    if encoding == DW_EH_PE_OMIT || encoding & DW_EH_PE_INDIRECT != 0 {
        return Err(ElfError::UnwindEncoding);
    }
    let field_address = section_address
        .checked_add(u64::try_from(*cursor).map_err(|_| ElfError::UnwindEncoding)?)
        .ok_or(ElfError::UnwindEncoding)?;
    let format = encoding & 0x0f;
    let value = match format {
        DW_EH_PE_ABSPTR => i128::from(read_encoded_u64(bytes, cursor)?),
        DW_EH_PE_ULEB128 => i128::from(read_uleb128(bytes, cursor)?),
        DW_EH_PE_UDATA2 => i128::from(read_encoded_u16(bytes, cursor)?),
        DW_EH_PE_UDATA4 => i128::from(read_encoded_u32(bytes, cursor)?),
        DW_EH_PE_UDATA8 => i128::from(read_encoded_u64(bytes, cursor)?),
        DW_EH_PE_SLEB128 => i128::from(read_sleb128(bytes, cursor)?),
        DW_EH_PE_SDATA2 => i128::from(read_encoded_i16(bytes, cursor)?),
        DW_EH_PE_SDATA4 => i128::from(read_encoded_i32(bytes, cursor)?),
        DW_EH_PE_SDATA8 => i128::from(read_encoded_i64(bytes, cursor)?),
        _ => return Err(ElfError::UnwindEncoding),
    };
    let base = match encoding & 0x70 {
        0 => 0i128,
        DW_EH_PE_PCREL => i128::from(field_address),
        DW_EH_PE_DATAREL => i128::from(datarel_base),
        _ => return Err(ElfError::UnwindEncoding),
    };
    let resolved = base.checked_add(value).ok_or(ElfError::UnwindEncoding)?;
    u64::try_from(resolved).map_err(|_| ElfError::UnwindEncoding)
}

fn read_uleb128(bytes: &[u8], cursor: &mut usize) -> Result<u64, ElfError> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *bytes.get(*cursor).ok_or(ElfError::UnwindTable)?;
        *cursor += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(ElfError::UnwindEncoding)
}

fn read_sleb128(bytes: &[u8], cursor: &mut usize) -> Result<i64, ElfError> {
    let mut value = 0i64;
    let mut shift = 0u32;
    loop {
        if shift >= 64 {
            return Err(ElfError::UnwindEncoding);
        }
        let byte = *bytes.get(*cursor).ok_or(ElfError::UnwindTable)?;
        *cursor += 1;
        value |= i64::from(byte & 0x7f) << shift;
        shift += 7;
        if byte & 0x80 == 0 {
            if shift < 64 && byte & 0x40 != 0 {
                value |= !0i64 << shift;
            }
            return Ok(value);
        }
    }
}

fn read_encoded_u16(bytes: &[u8], cursor: &mut usize) -> Result<u16, ElfError> {
    let value = read_u16(bytes, *cursor).map_err(|_| ElfError::UnwindTable)?;
    *cursor += 2;
    Ok(value)
}

fn read_encoded_u32(bytes: &[u8], cursor: &mut usize) -> Result<u32, ElfError> {
    let value = read_u32(bytes, *cursor).map_err(|_| ElfError::UnwindTable)?;
    *cursor += 4;
    Ok(value)
}

fn read_encoded_u64(bytes: &[u8], cursor: &mut usize) -> Result<u64, ElfError> {
    let value = read_u64(bytes, *cursor).map_err(|_| ElfError::UnwindTable)?;
    *cursor += 8;
    Ok(value)
}

fn read_encoded_i16(bytes: &[u8], cursor: &mut usize) -> Result<i16, ElfError> {
    Ok(i16::from_le_bytes(
        read_encoded_u16(bytes, cursor)?.to_le_bytes(),
    ))
}

fn read_encoded_i32(bytes: &[u8], cursor: &mut usize) -> Result<i32, ElfError> {
    Ok(i32::from_le_bytes(
        read_encoded_u32(bytes, cursor)?.to_le_bytes(),
    ))
}

fn read_encoded_i64(bytes: &[u8], cursor: &mut usize) -> Result<i64, ElfError> {
    Ok(i64::from_le_bytes(
        read_encoded_u64(bytes, cursor)?.to_le_bytes(),
    ))
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

    const SEND_ANCHOR: &[u8] = b"assertion (argc == 2) failed: fixture needs 2 arguments";
    const CALLBACK: u64 = 0x200;
    const CONVERTER: u64 = 0x280;
    const RESPONSE_ACTION: u64 = 0x300;
    const DISPATCH_HELPER: u64 = 0x380;
    const RESOLVER_THUNK: u64 = 0x400;
    const RESOLVER: u64 = 0x480;
    const TEXT_END: u64 = 0x520;
    const ANCHOR_RVA: u64 = 0x600;
    const RESULT_RVA: u64 = 0x660;
    const ERR_MSG_RVA: u64 = 0x670;
    const RSP_RVA: u64 = 0x680;
    const RESPONSE_TABLE: u64 = 0x800;
    const RESPONSE_SLOT: u64 = 0x820;
    const DYNAMIC_RVA: u64 = 0x900;
    const RELA_RVA: u64 = 0x980;
    const EH_FRAME_HDR: u64 = 0xa00;

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

    fn write_call(image: &mut [u8], instruction: u64, target: u64) {
        image[instruction as usize] = 0xe8;
        let displacement = target as i64 - instruction as i64 - 5;
        image[instruction as usize + 1..instruction as usize + 5]
            .copy_from_slice(&(displacement as i32).to_le_bytes());
    }

    fn write_lea(image: &mut [u8], instruction: u64, target: u64) {
        image[instruction as usize..instruction as usize + 3].copy_from_slice(&[0x48, 0x8d, 0x15]);
        let displacement = target as i64 - instruction as i64 - 7;
        image[instruction as usize + 3..instruction as usize + 7]
            .copy_from_slice(&(displacement as i32).to_le_bytes());
    }

    fn write_eh_frame_header(image: &mut [u8], starts: &[u64]) {
        let offset = EH_FRAME_HDR as usize;
        image[offset..offset + 4].copy_from_slice(&[1, 0x1b, 0x03, 0x3b]);
        write_u32(image, offset + 4, 0);
        write_u32(image, offset + 8, starts.len() as u32);
        for (index, begin) in starts.iter().copied().enumerate() {
            let entry = offset + 12 + index * 8;
            write_u32(
                image,
                entry,
                (begin as i64 - EH_FRAME_HDR as i64) as i32 as u32,
            );
            write_u32(image, entry + 4, 0);
        }
    }

    fn image() -> Vec<u8> {
        let mut image = vec![0u8; 0xc00];
        image[..4].copy_from_slice(b"\x7fELF");
        image[4..7].copy_from_slice(&[2, 1, 1]);
        write_u16(&mut image, 16, 3);
        write_u16(&mut image, 18, 62);
        write_u32(&mut image, 20, 1);
        write_u64(&mut image, 32, 0x40);
        write_u16(&mut image, 52, ELF_HEADER_SIZE as u16);
        write_u16(&mut image, 54, PROGRAM_HEADER_SIZE as u16);
        write_u16(&mut image, 56, 6);
        write_program_header(
            &mut image,
            0,
            PT_LOAD,
            PF_R | PF_X,
            CALLBACK,
            CALLBACK,
            TEXT_END - CALLBACK,
        );
        write_program_header(&mut image, 1, PT_LOAD, PF_R, 0x600, 0x600, 0x100);
        write_program_header(&mut image, 2, PT_LOAD, PF_R | PF_W, 0x800, 0x800, 0x300);
        write_program_header(
            &mut image,
            3,
            PT_DYNAMIC,
            PF_R | PF_W,
            DYNAMIC_RVA,
            DYNAMIC_RVA,
            0x40,
        );
        write_program_header(
            &mut image,
            4,
            PT_GNU_EH_FRAME,
            PF_R,
            EH_FRAME_HDR,
            EH_FRAME_HDR,
            0x40,
        );
        write_program_header(&mut image, 5, PT_NOTE, 0, 0xb00, 0, 0x20);

        write_u32(&mut image, 0xb00, 4);
        write_u32(&mut image, 0xb04, 4);
        write_u32(&mut image, 0xb08, 3);
        image[0xb0c..0xb10].copy_from_slice(b"GNU\0");
        image[0xb10..0xb14].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);

        image[ANCHOR_RVA as usize..ANCHOR_RVA as usize + SEND_ANCHOR.len()]
            .copy_from_slice(SEND_ANCHOR);
        image[RESULT_RVA as usize..RESULT_RVA as usize + 7].copy_from_slice(b"result\0");
        image[ERR_MSG_RVA as usize..ERR_MSG_RVA as usize + 7].copy_from_slice(b"errMsg\0");
        image[RSP_RVA as usize..RSP_RVA as usize + 4].copy_from_slice(b"rsp\0");

        image[CALLBACK as usize..TEXT_END as usize].fill(0x90);
        write_call(&mut image, CALLBACK + 0x10, CONVERTER);
        write_call(&mut image, CALLBACK + 0x20, CONVERTER);
        write_lea(&mut image, CALLBACK + 0x30, ANCHOR_RVA);
        write_lea(&mut image, CALLBACK + 0x40, RESPONSE_TABLE);
        write_call(&mut image, RESPONSE_ACTION + 0x10, DISPATCH_HELPER);
        write_lea(&mut image, DISPATCH_HELPER + 0x10, RESOLVER_THUNK);
        write_call(&mut image, RESOLVER_THUNK + 0x10, RESOLVER);
        write_lea(&mut image, RESOLVER + 0x10, RESULT_RVA);
        write_lea(&mut image, RESOLVER + 0x20, ERR_MSG_RVA);
        write_lea(&mut image, RESOLVER + 0x30, RSP_RVA);
        write_i64(&mut image, DYNAMIC_RVA as usize, DT_RELA);
        write_u64(&mut image, DYNAMIC_RVA as usize + 8, RELA_RVA);
        write_i64(&mut image, DYNAMIC_RVA as usize + 16, DT_RELASZ);
        write_u64(
            &mut image,
            DYNAMIC_RVA as usize + 24,
            RELA_ENTRY_SIZE as u64,
        );
        write_i64(&mut image, DYNAMIC_RVA as usize + 32, DT_RELAENT);
        write_u64(
            &mut image,
            DYNAMIC_RVA as usize + 40,
            RELA_ENTRY_SIZE as u64,
        );
        write_i64(&mut image, DYNAMIC_RVA as usize + 48, DT_NULL);
        write_u64(&mut image, RESPONSE_SLOT as usize, 0);
        write_u64(&mut image, RELA_RVA as usize, RESPONSE_SLOT);
        write_u64(&mut image, RELA_RVA as usize + 8, R_X86_64_RELATIVE as u64);
        write_i64(&mut image, RELA_RVA as usize + 16, RESPONSE_ACTION as i64);
        write_eh_frame_header(
            &mut image,
            &[
                CALLBACK,
                CONVERTER,
                RESPONSE_ACTION,
                DISPATCH_HELPER,
                RESOLVER_THUNK,
                RESOLVER,
            ],
        );
        image
    }

    #[test]
    fn locates_packet_targets_from_xrefs_without_a_version_profile() {
        let image = image();
        let elf = ElfImage::parse(&image).unwrap();
        assert_eq!(
            locate_packet_binding(&elf, SEND_ANCHOR).unwrap(),
            LocatedPacketBinding {
                receive_rva: 0,
                anchor_rva: ANCHOR_RVA,
                anchor_xref_rva: CALLBACK + 0x30,
                napi_callback_rva: CALLBACK,
                converter_rva: CONVERTER,
                result_anchor_rva: RESULT_RVA,
                result_xref_rva: RESOLVER + 0x10,
                err_msg_anchor_rva: ERR_MSG_RVA,
                err_msg_xref_rva: RESOLVER + 0x20,
                rsp_anchor_rva: RSP_RVA,
                rsp_xref_rva: RESOLVER + 0x30,
                response_table_xref_rva: CALLBACK + 0x40,
                response_table_rva: RESPONSE_TABLE,
                response_action_slot_rva: RESPONSE_SLOT,
                response_action_rva: RESPONSE_ACTION,
                dispatch_helper_rva: DISPATCH_HELPER,
                resolver_thunk_rva: RESOLVER_THUNK,
                resolve_action_rva: RESOLVER,
            }
        );
        assert_eq!(elf.build_id().unwrap(), [0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn rejects_ambiguous_send_anchor_xrefs() {
        let mut image = image();
        write_lea(&mut image, CALLBACK + 0x50, ANCHOR_RVA);
        let elf = ElfImage::parse(&image).unwrap();
        assert!(matches!(
            locate_packet_binding(&elf, SEND_ANCHOR),
            Err(ElfError::SendAnchorXref)
        ));
    }

    #[test]
    fn rejects_missing_converter_call_pair() {
        let mut image = image();
        image[(CALLBACK + 0x20) as usize] = 0x90;
        let elf = ElfImage::parse(&image).unwrap();
        assert!(matches!(
            locate_packet_binding(&elf, SEND_ANCHOR),
            Err(ElfError::ConverterScan)
        ));
    }

    #[test]
    fn rejects_response_anchors_split_across_functions() {
        let mut image = image();
        write_lea(&mut image, CONVERTER + 0x10, RSP_RVA);
        image[(RESOLVER + 0x30) as usize..(RESOLVER + 0x37) as usize].fill(0x90);
        let elf = ElfImage::parse(&image).unwrap();
        assert!(matches!(
            locate_packet_binding(&elf, SEND_ANCHOR),
            Err(ElfError::ResolverScan)
        ));
    }

    #[test]
    fn rejects_invalid_unwind_table_and_permissions() {
        let mut broken_unwind = image();
        broken_unwind[EH_FRAME_HDR as usize] = 2;
        assert!(matches!(
            ElfImage::parse(&broken_unwind).unwrap().unwind_functions(),
            Err(ElfError::UnwindTable)
        ));

        let mut executable_strings = image();
        write_u32(
            &mut executable_strings,
            0x40 + PROGRAM_HEADER_SIZE + 4,
            PF_R | PF_X,
        );
        let elf = ElfImage::parse(&executable_strings).unwrap();
        assert!(matches!(
            locate_packet_binding(&elf, SEND_ANCHOR),
            Err(ElfError::SendAnchorScan)
        ));
    }

    #[test]
    fn rejects_invalid_elf_header() {
        assert!(matches!(
            ElfImage::parse(b"not an ELF image"),
            Err(ElfError::Truncated)
        ));
    }

    #[test]
    #[ignore = "set QQNT_WRAPPER_FIXTURE to an extracted Linux wrapper.node"]
    fn locates_an_extracted_linux_qqnt_wrapper() {
        let path = std::env::var_os("QQNT_WRAPPER_FIXTURE")
            .expect("QQNT_WRAPPER_FIXTURE must point to wrapper.node");
        let bytes = std::fs::read(path).unwrap();
        let elf = ElfImage::parse(&bytes).unwrap();
        let located = locate_packet_binding(&elf, crate::locator::SEND_ANCHOR.as_bytes()).unwrap();
        assert_ne!(located.anchor_xref_rva, 0);
        assert_ne!(located.converter_rva, 0);
        assert_ne!(located.resolve_action_rva, 0);
    }
}
