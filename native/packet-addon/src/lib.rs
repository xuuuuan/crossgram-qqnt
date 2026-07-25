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
pub struct SendBindingLocation {
    pub module_base: String,
    pub anchor_rva: u32,
    pub xref_rva: u32,
    pub function_rva: u32,
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
pub fn locate_send_binding() -> Result<SendBindingLocation> {
    let location = locator::locate_loaded_wrapper().map_err(|error| {
        Error::from_reason(format!("failed to locate QQNT send binding: {error}"))
    })?;
    Ok(SendBindingLocation {
        module_base: format!("0x{:x}", location.module_base),
        anchor_rva: location.anchor_rva,
        xref_rva: location.xref_rva,
        function_rva: location.function_rva,
    })
}
