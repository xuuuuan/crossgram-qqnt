use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Section {
    pub virtual_address: u32,
    pub virtual_size: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeFunction {
    pub begin: u32,
    pub end: u32,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PeError {
    #[error("truncated PE image")]
    Truncated,
    #[error("invalid PE signature")]
    InvalidSignature,
    #[error("PE section {0} was not found")]
    MissingSection(String),
}

fn read_u16(image: &[u8], offset: usize) -> Result<u16, PeError> {
    let bytes = image.get(offset..offset + 2).ok_or(PeError::Truncated)?;
    Ok(u16::from_le_bytes(bytes.try_into().unwrap()))
}

fn read_u32(image: &[u8], offset: usize) -> Result<u32, PeError> {
    let bytes = image.get(offset..offset + 4).ok_or(PeError::Truncated)?;
    Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
}

pub fn section(image: &[u8], wanted: &str) -> Result<Section, PeError> {
    let pe = read_u32(image, 0x3c)? as usize;
    if image.get(pe..pe + 4) != Some(b"PE\0\0") {
        return Err(PeError::InvalidSignature);
    }
    let count = read_u16(image, pe + 6)? as usize;
    let optional_size = read_u16(image, pe + 20)? as usize;
    let table = pe + 24 + optional_size;
    for index in 0..count {
        let offset = table + index * 40;
        let name_bytes = image.get(offset..offset + 8).ok_or(PeError::Truncated)?;
        let end = name_bytes.iter().position(|byte| *byte == 0).unwrap_or(8);
        if &name_bytes[..end] == wanted.as_bytes() {
            return Ok(Section {
                virtual_size: read_u32(image, offset + 8)?,
                virtual_address: read_u32(image, offset + 12)?,
            });
        }
    }
    Err(PeError::MissingSection(wanted.into()))
}

pub fn find_bytes(image: &[u8], needle: &[u8]) -> Vec<u32> {
    if needle.is_empty() || needle.len() > image.len() {
        return Vec::new();
    }
    image
        .windows(needle.len())
        .enumerate()
        .filter_map(|(offset, bytes)| (bytes == needle).then_some(offset as u32))
        .collect()
}

pub fn find_bytes_in_section(image: &[u8], section: Section, needle: &[u8]) -> Vec<u32> {
    let start = section.virtual_address as usize;
    let end = start
        .saturating_add(section.virtual_size as usize)
        .min(image.len());
    image
        .get(start..end)
        .map(|bytes| {
            find_bytes(bytes, needle)
                .into_iter()
                .map(|offset| offset + section.virtual_address)
                .collect()
        })
        .unwrap_or_default()
}

pub fn find_rip_relative_xrefs(image: &[u8], text: Section, target: u32) -> Vec<u32> {
    let start = text.virtual_address as usize;
    let end = start
        .saturating_add(text.virtual_size as usize)
        .min(image.len());
    let Some(bytes) = image.get(start..end) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for (offset, instruction) in bytes.windows(7).enumerate() {
        if !(0x40..=0x4f).contains(&instruction[0])
            || instruction[1] != 0x8d
            || instruction[2] & 0xc7 != 0x05
        {
            continue;
        }
        let displacement = i32::from_le_bytes(instruction[3..7].try_into().unwrap()) as i64;
        let rva = text.virtual_address as i64 + offset as i64;
        if rva + 7 + displacement == target as i64 {
            result.push(rva as u32);
        }
    }
    result
}

pub fn runtime_functions(image: &[u8], pdata: Section) -> Vec<RuntimeFunction> {
    let start = pdata.virtual_address as usize;
    let end = start
        .saturating_add(pdata.virtual_size as usize)
        .min(image.len());
    image
        .get(start..end)
        .into_iter()
        .flat_map(|bytes| bytes.chunks_exact(12))
        .filter_map(|entry| {
            let begin = u32::from_le_bytes(entry[0..4].try_into().ok()?);
            let end = u32::from_le_bytes(entry[4..8].try_into().ok()?);
            (begin < end).then_some(RuntimeFunction { begin, end })
        })
        .collect()
}

pub fn containing_function(functions: &[RuntimeFunction], address: u32) -> Option<RuntimeFunction> {
    let index = functions.partition_point(|function| function.begin <= address);
    index.checked_sub(1).and_then(|index| {
        let function = functions[index];
        (address < function.end).then_some(function)
    })
}

/// Finds the first pair of nearby direct calls that share a target.
///
/// Generated N-API wrappers convert adjacent arguments with adjacent calls to
/// the same conversion function. Looking through the owning function keeps the
/// locator independent of QQNT's version-specific RVAs.
pub fn first_nearby_repeated_call_target(image: &[u8], function: RuntimeFunction) -> Option<u32> {
    let calls = direct_calls(image, function);
    calls.windows(2).find_map(|pair| {
        let (first_call, first_target) = pair[0];
        let (second_call, second_target) = pair[1];
        (first_target == second_target
            && (8..=32).contains(&second_call.saturating_sub(first_call)))
        .then_some(first_target)
    })
}

pub fn direct_calls(image: &[u8], function: RuntimeFunction) -> Vec<(u32, u32)> {
    let Some(bytes) = image.get(function.begin as usize..function.end as usize) else {
        return Vec::new();
    };
    bytes
        .windows(5)
        .enumerate()
        .filter_map(|(offset, instruction)| {
            if instruction[0] != 0xe8 {
                return None;
            }
            let call_rva = function.begin.checked_add(offset as u32)?;
            let displacement = i32::from_le_bytes(instruction[1..5].try_into().ok()?) as i64;
            let target = call_rva as i64 + 5 + displacement;
            u32::try_from(target).ok().map(|target| (call_rva, target))
        })
        .collect()
}

pub fn rip_relative_lea_targets(image: &[u8], function: RuntimeFunction) -> Vec<(u32, u32)> {
    let Some(bytes) = image.get(function.begin as usize..function.end as usize) else {
        return Vec::new();
    };
    bytes
        .windows(7)
        .enumerate()
        .filter_map(|(offset, instruction)| {
            if !(0x40..=0x4f).contains(&instruction[0])
                || instruction[1] != 0x8d
                || instruction[2] & 0xc7 != 0x05
            {
                return None;
            }
            let instruction_rva = function.begin.checked_add(offset as u32)?;
            let displacement = i32::from_le_bytes(instruction[3..7].try_into().ok()?) as i64;
            let target = instruction_rva as i64 + 7 + displacement;
            u32::try_from(target)
                .ok()
                .map(|target| (instruction_rva, target))
        })
        .collect()
}

pub fn read_u64(image: &[u8], rva: u32) -> Option<u64> {
    let bytes = image.get(rva as usize..rva as usize + 8)?;
    Some(u64::from_le_bytes(bytes.try_into().ok()?))
}

/// Resolves the compiler thunk used by QQNT's async response dispatcher:
/// `mov rcx, [rcx]; jmp rel32`.
pub fn indirect_rcx_jump_target(image: &[u8], thunk_rva: u32) -> Option<u32> {
    let bytes = image.get(thunk_rva as usize..thunk_rva as usize + 8)?;
    if bytes[..4] != [0x48, 0x8b, 0x09, 0xe9] {
        return None;
    }
    let displacement = i32::from_le_bytes(bytes[4..8].try_into().ok()?) as i64;
    u32::try_from(thunk_rva as i64 + 8 + displacement).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_rip_relative_lea_and_owning_function() {
        let mut image = vec![0u8; 0x400];
        let instruction_rva = 0x120u32;
        let target_rva = 0x300u32;
        image[instruction_rva as usize..instruction_rva as usize + 3]
            .copy_from_slice(&[0x4c, 0x8d, 0x05]);
        let displacement = target_rva as i32 - instruction_rva as i32 - 7;
        image[instruction_rva as usize + 3..instruction_rva as usize + 7]
            .copy_from_slice(&displacement.to_le_bytes());
        let xrefs = find_rip_relative_xrefs(
            &image,
            Section {
                virtual_address: 0x100,
                virtual_size: 0x100,
            },
            target_rva,
        );
        assert_eq!(xrefs, vec![instruction_rva]);
        assert_eq!(
            containing_function(
                &[
                    RuntimeFunction {
                        begin: 0x100,
                        end: 0x110
                    },
                    RuntimeFunction {
                        begin: 0x110,
                        end: 0x140
                    },
                ],
                instruction_rva
            ),
            Some(RuntimeFunction {
                begin: 0x110,
                end: 0x140
            })
        );
    }

    #[test]
    fn finds_all_anchor_occurrences() {
        assert_eq!(find_bytes(b"abc--abc", b"abc"), vec![0, 5]);
        assert!(find_bytes(b"abc", b"").is_empty());
        assert_eq!(
            find_bytes_in_section(
                b"skip--abc--abc",
                Section {
                    virtual_address: 6,
                    virtual_size: 10,
                },
                b"abc",
            ),
            vec![6, 11],
        );
    }

    #[test]
    fn finds_adjacent_calls_to_the_same_converter() {
        let mut image = vec![0x90u8; 0x200];
        let function = RuntimeFunction {
            begin: 0x40,
            end: 0xa0,
        };
        for call_rva in [0x58u32, 0x68] {
            image[call_rva as usize] = 0xe8;
            let displacement = 0x120i32 - call_rva as i32 - 5;
            image[call_rva as usize + 1..call_rva as usize + 5]
                .copy_from_slice(&displacement.to_le_bytes());
        }
        assert_eq!(
            first_nearby_repeated_call_target(&image, function),
            Some(0x120),
        );
        assert_eq!(
            direct_calls(&image, function),
            vec![(0x58, 0x120), (0x68, 0x120)]
        );
    }

    #[test]
    fn finds_lea_targets_and_response_thunks() {
        let mut image = vec![0x90u8; 0x300];
        let function = RuntimeFunction {
            begin: 0x40,
            end: 0xa0,
        };
        image[0x50..0x53].copy_from_slice(&[0x4c, 0x8d, 0x05]);
        image[0x53..0x57].copy_from_slice(&(0x180i32 - 0x50 - 7).to_le_bytes());
        assert_eq!(
            rip_relative_lea_targets(&image, function),
            vec![(0x50, 0x180)],
        );

        image[0x180..0x188].copy_from_slice(&0x1800_1234_5678_9abcu64.to_le_bytes());
        assert_eq!(read_u64(&image, 0x180), Some(0x1800_1234_5678_9abc));

        image[0x200..0x204].copy_from_slice(&[0x48, 0x8b, 0x09, 0xe9]);
        image[0x204..0x208].copy_from_slice(&(0x140i32 - 0x200 - 8).to_le_bytes());
        assert_eq!(indirect_rcx_jump_target(&image, 0x200), Some(0x140));
    }
}
