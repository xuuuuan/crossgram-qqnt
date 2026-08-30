mod elf;
mod hook;
mod locator;
mod pe;
mod proto;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use prost::Message;

#[napi(object)]
pub struct PacketRequest {
    pub command: String,
    pub payload: Buffer,
}

#[napi(object)]
pub struct Rkey {
    pub value: String,
    pub ttl_seconds: String,
    pub created_at: u32,
    pub kind: u32,
}

#[napi(object)]
pub struct DirectUrl {
    pub url: String,
    pub ttl_seconds: u32,
    pub created_at: u32,
}

#[napi(object)]
pub struct SysFace {
    pub face_id: String,
    pub name: String,
    pub url: String,
    pub ani_sticker_type: i32,
    pub ani_sticker_pack_id: i32,
    pub ani_sticker_id: i32,
    pub width: i32,
    pub height: i32,
}

#[napi(object)]
pub struct SendBindingLocation {
    pub module_base: String,
    pub locator: String,
    pub time_date_stamp: u32,
    pub size_of_image: u32,
    pub anchor_rva: u32,
    pub xref_rva: u32,
    pub function_rva: u32,
    pub converter_rva: u32,
    pub response_rva: u32,
}

#[napi(object)]
pub struct PacketBindingProbe {
    pub receive_rva: String,
    pub module_base: String,
    pub module_path: String,
    pub locator: String,
    pub build_id: String,
    pub sha256: String,
    pub anchor_rva: String,
    pub anchor_xref_rva: String,
    pub napi_callback_rva: String,
    pub converter_rva: String,
    pub result_anchor_rva: String,
    pub result_xref_rva: String,
    pub err_msg_anchor_rva: String,
    pub err_msg_xref_rva: String,
    pub rsp_anchor_rva: String,
    pub rsp_xref_rva: String,
    pub response_table_xref_rva: String,
    pub response_table_rva: String,
    pub response_action_slot_rva: String,
    pub response_action_rva: String,
    pub dispatch_helper_rva: String,
    pub resolver_thunk_rva: String,
    pub resolve_action_rva: String,
}

#[napi(object)]
pub struct ReceivedPacket {
    pub uin: String,
    pub command: String,
    pub sequence: String,
    pub payload: Buffer,
}

/// Calls QQNT's bound sendSsoCmdReqByContend function from the addon so the
/// TypeScript layer never needs to know its native implementation details.
#[napi]
pub fn send_packet<'scope>(
    send: Function<'scope, FnArgs<(String, Buffer)>, Unknown<'scope>>,
    command: String,
    payload: Buffer,
) -> Result<Unknown<'scope>> {
    if command.is_empty() {
        return Err(Error::from_reason("packet command must not be empty"));
    }
    send.call(FnArgs {
        data: (command, payload),
    })
}

#[napi]
pub fn encode_fetch_rkey_request() -> PacketRequest {
    let envelope = proto::fetch_rkey_packet();
    PacketRequest {
        command: "OidbSvcTrpcTcp.0x9067_202".into(),
        payload: envelope.encode_to_vec().into(),
    }
}

#[napi]
pub fn decode_fetch_rkey_response(payload: Buffer) -> Result<Vec<Rkey>> {
    proto::decode_rkeys(payload.as_ref())
        .map(|rkeys| {
            rkeys
                .into_iter()
                .map(|rkey| Rkey {
                    value: rkey.rkey,
                    ttl_seconds: rkey.ttl.to_string(),
                    created_at: rkey.created_at,
                    kind: rkey.kind,
                })
                .collect()
        })
        .map_err(|error| Error::from_reason(format!("invalid FetchRkey response: {error}")))
}

#[napi]
pub fn encode_fetch_sys_faces_request() -> PacketRequest {
    let envelope = proto::fetch_sys_faces_packet();
    PacketRequest {
        command: "OidbSvcTrpcTcp.0x9154_1".into(),
        payload: envelope.encode_to_vec().into(),
    }
}

#[napi]
pub fn decode_fetch_sys_faces_response(payload: Buffer) -> Result<Vec<SysFace>> {
    proto::decode_sys_faces(payload.as_ref())
        .map(|faces| {
            faces
                .into_iter()
                .map(|face| SysFace {
                    face_id: face.q_sid,
                    name: face.q_des,
                    url: face.url.map(|url| url.base_url).unwrap_or_default(),
                    ani_sticker_type: face.ani_sticker_type,
                    ani_sticker_pack_id: face.ani_sticker_pack_id,
                    ani_sticker_id: face.ani_sticker_id,
                    width: face.ani_sticker_width,
                    height: face.ani_sticker_height,
                })
                .collect()
        })
        .map_err(|error| Error::from_reason(format!("invalid FetchSysFaces response: {error}")))
}

#[napi]
pub fn encode_video_download_request(
    chat_type: u32,
    peer: String,
    self_uid: String,
    file_uuid: String,
) -> Result<PacketRequest> {
    packet_request(
        proto::video_download_packet(chat_type, &peer, &self_uid, &file_uuid),
        "video download",
    )
}

#[napi]
pub fn decode_video_download_response(payload: Buffer) -> Result<DirectUrl> {
    direct_url(
        proto::decode_video_download(payload.as_ref()),
        "video download",
    )
}

#[napi]
pub fn encode_group_file_download_request(
    group: String,
    file_uuid: String,
) -> Result<PacketRequest> {
    packet_request(
        proto::group_file_download_packet(&group, &file_uuid),
        "group file download",
    )
}

#[napi]
pub fn decode_group_file_download_response(payload: Buffer) -> Result<DirectUrl> {
    direct_url(
        proto::decode_group_file_download(payload.as_ref()),
        "group file download",
    )
}

#[napi]
pub fn encode_private_file_download_request(
    self_uid: String,
    file_uuid: String,
    file_hash: String,
) -> Result<PacketRequest> {
    packet_request(
        proto::private_file_download_packet(&self_uid, &file_uuid, &file_hash),
        "private file download",
    )
}

#[napi]
pub fn decode_private_file_download_response(payload: Buffer) -> Result<DirectUrl> {
    direct_url(
        proto::decode_private_file_download(payload.as_ref()),
        "private file download",
    )
}

#[napi]
pub fn refresh_image_url(original_url: String, rkey: String) -> Result<String> {
    let mut url = url::Url::parse(&original_url)
        .map_err(|error| Error::from_reason(format!("invalid QQ image URL: {error}")))?;
    let value = rkey
        .strip_prefix("&rkey=")
        .or_else(|| rkey.strip_prefix("rkey="))
        .unwrap_or(&rkey);
    if value.is_empty() {
        return Err(Error::from_reason("QQ image rkey must not be empty"));
    }
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| key != "rkey")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    pairs.push(("rkey".into(), value.into()));
    url.query_pairs_mut().clear().extend_pairs(pairs);
    Ok(url.into())
}

#[napi]
pub fn probe_packet_binding() -> Result<PacketBindingProbe> {
    if !cfg!(target_os = "linux") {
        return Err(Error::from_reason(
            "probing the QQNT packet binding is only supported on Linux",
        ));
    }
    let probe = locator::probe_packet_binding().map_err(|error| {
        Error::from_reason(format!("failed to probe QQNT packet binding: {error}"))
    })?;
    Ok(PacketBindingProbe {
        receive_rva: format!("0x{:x}", probe.receive_rva),
        module_base: format!("0x{:x}", probe.module_base),
        module_path: probe.module_path,
        locator: probe.locator.into(),
        build_id: elf::hex(&probe.build_id),
        sha256: elf::hex(&probe.sha256),
        anchor_rva: format!("0x{:x}", probe.anchor_rva),
        anchor_xref_rva: format!("0x{:x}", probe.anchor_xref_rva),
        napi_callback_rva: format!("0x{:x}", probe.napi_callback_rva),
        converter_rva: format!("0x{:x}", probe.converter_rva),
        result_anchor_rva: format!("0x{:x}", probe.result_anchor_rva),
        result_xref_rva: format!("0x{:x}", probe.result_xref_rva),
        err_msg_anchor_rva: format!("0x{:x}", probe.err_msg_anchor_rva),
        err_msg_xref_rva: format!("0x{:x}", probe.err_msg_xref_rva),
        rsp_anchor_rva: format!("0x{:x}", probe.rsp_anchor_rva),
        rsp_xref_rva: format!("0x{:x}", probe.rsp_xref_rva),
        response_table_xref_rva: format!("0x{:x}", probe.response_table_xref_rva),
        response_table_rva: format!("0x{:x}", probe.response_table_rva),
        response_action_slot_rva: format!("0x{:x}", probe.response_action_slot_rva),
        response_action_rva: format!("0x{:x}", probe.response_action_rva),
        dispatch_helper_rva: format!("0x{:x}", probe.dispatch_helper_rva),
        resolver_thunk_rva: format!("0x{:x}", probe.resolver_thunk_rva),
        resolve_action_rva: format!("0x{:x}", probe.resolve_action_rva),
    })
}

#[napi]
pub fn locate_send_binding() -> Result<SendBindingLocation> {
    if !cfg!(windows) {
        return Err(Error::from_reason(
            "locating the QQNT send binding is only supported on Windows",
        ));
    }
    let location = locator::locate_loaded_wrapper().map_err(|error| {
        Error::from_reason(format!("failed to locate QQNT send binding: {error}"))
    })?;
    Ok(binding_location(location))
}

#[napi]
pub fn install_send_hook() -> Result<SendBindingLocation> {
    install_send_hook_impl()
}

#[napi]
pub fn install_receive_hook() -> Result<String> {
    #[cfg(target_os = "linux")]
    {
        let mut cache = CACHED_PROBE
            .lock()
            .map_err(|_| Error::from_reason("QQNT packet probe cache poisoned"))?;
        if cache.is_none() {
            let probe = locator::probe_packet_binding().map_err(|error| {
                Error::from_reason(format!("failed to probe QQNT packet binding: {error}"))
            })?;
            *cache = Some(probe);
        }
        let probe = cache.as_ref().expect("probe cached");
        let rva = hook::install_receive(probe).map_err(|error| {
            Error::from_reason(format!("failed to install QQNT receive hook: {error}"))
        })?;
        return Ok(format!("0x{rva:x}"));
    }
    #[allow(unreachable_code)]
    Err(Error::from_reason("QQNT receive hook is only supported on Linux"))
}

#[napi]
pub fn drain_receive_packets() -> Vec<ReceivedPacket> {
    hook::drain_receive_packets()
        .into_iter()
        .map(|packet| ReceivedPacket {
            uin: packet.uin,
            command: packet.command,
            sequence: packet.sequence.to_string(),
            payload: packet.payload.into(),
        })
        .collect()
}

#[cfg(windows)]
fn install_send_hook_impl() -> Result<SendBindingLocation> {
    let location = locator::locate_loaded_wrapper().map_err(|error| {
        Error::from_reason(format!("failed to locate QQNT send binding: {error}"))
    })?;
    hook::install(&location).map_err(|error| {
        Error::from_reason(format!("failed to install QQNT send hook: {error}"))
    })?;
    Ok(binding_location(location))
}

#[cfg(target_os = "linux")]
static CACHED_PROBE: std::sync::Mutex<Option<elf::PacketBindingProbe>> =
    std::sync::Mutex::new(None);

#[cfg(target_os = "linux")]
fn install_send_hook_impl() -> Result<SendBindingLocation> {
    // Cache the probe because installation patches the converter and resolver
    // bytes that the locator compares with the on-disk wrapper.
    let mut cache = CACHED_PROBE
        .lock()
        .map_err(|_| Error::from_reason("QQNT packet probe cache poisoned"))?;
    if cache.is_none() {
        let probe = locator::probe_packet_binding().map_err(|error| {
            Error::from_reason(format!("failed to probe QQNT packet binding: {error}"))
        })?;
        *cache = Some(probe);
    }
    let probe = cache.as_ref().expect("probe cached");
    hook::install(probe).map_err(|error| {
        Error::from_reason(format!("failed to install QQNT send hook: {error}"))
    })?;
    Ok(SendBindingLocation {
        module_base: format!("0x{:x}", probe.module_base),
        locator: probe.locator.into(),
        time_date_stamp: 0,
        size_of_image: 0,
        anchor_rva: 0,
        xref_rva: 0,
        function_rva: 0,
        converter_rva: probe.converter_rva as u32,
        response_rva: probe.resolve_action_rva as u32,
    })
}

#[cfg(not(any(windows, target_os = "linux")))]
fn install_send_hook_impl() -> Result<SendBindingLocation> {
    Err(Error::from_reason(
        "installing the QQNT send hook is only supported on Windows and Linux",
    ))
}

fn binding_location(location: locator::LocatedBinding) -> SendBindingLocation {
    SendBindingLocation {
        module_base: format!("0x{:x}", location.module_base),
        locator: location.locator.name().into(),
        time_date_stamp: location.identity.time_date_stamp,
        size_of_image: location.identity.size_of_image,
        anchor_rva: location.anchor_rva,
        xref_rva: location.xref_rva,
        function_rva: location.function_rva,
        converter_rva: location.converter_rva,
        response_rva: location.response_rva,
    }
}

fn packet_request(
    packet: std::result::Result<proto::OidbEnvelope, String>,
    name: &str,
) -> Result<PacketRequest> {
    let envelope =
        packet.map_err(|error| Error::from_reason(format!("invalid {name} request: {error}")))?;
    Ok(PacketRequest {
        command: format!(
            "OidbSvcTrpcTcp.0x{:x}_{}",
            envelope.command, envelope.sub_command
        ),
        payload: envelope.encode_to_vec().into(),
    })
}

fn direct_url(
    result: std::result::Result<proto::DirectUrl, proto::DecodePacketError>,
    name: &str,
) -> Result<DirectUrl> {
    result
        .map(|value| DirectUrl {
            url: value.url,
            ttl_seconds: value.ttl_seconds,
            created_at: value.created_at,
        })
        .map_err(|error| Error::from_reason(format!("invalid {name} response: {error}")))
}
