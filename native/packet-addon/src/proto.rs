use prost::Message;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DecodeRkeyError {
    #[error(transparent)]
    Protobuf(#[from] prost::DecodeError),
    #[error("OIDB error {code}: {message}")]
    Oidb { code: u32, message: String },
}

#[derive(Clone, PartialEq, Message)]
pub struct OidbEnvelope {
    #[prost(uint32, tag = "1")]
    pub command: u32,
    #[prost(uint32, tag = "2")]
    pub sub_command: u32,
    #[prost(uint32, tag = "3")]
    pub error_code: u32,
    #[prost(bytes = "vec", tag = "4")]
    pub body: Vec<u8>,
    #[prost(string, optional, tag = "5")]
    pub error_message: Option<String>,
    #[prost(uint32, tag = "12")]
    pub is_reserved: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct FetchRkeyRequest {
    #[prost(message, optional, tag = "1")]
    pub request_head: Option<MultiMediaRequestHead>,
    #[prost(message, optional, tag = "4")]
    pub download_rkey: Option<DownloadRkeyRequest>,
}

#[derive(Clone, PartialEq, Message)]
pub struct MultiMediaRequestHead {
    #[prost(message, optional, tag = "1")]
    pub common: Option<CommonHead>,
    #[prost(message, optional, tag = "2")]
    pub scene: Option<SceneInfo>,
    #[prost(message, optional, tag = "3")]
    pub client: Option<ClientMeta>,
}

#[derive(Clone, PartialEq, Message)]
pub struct CommonHead {
    #[prost(uint32, tag = "1")]
    pub request_id: u32,
    #[prost(uint32, tag = "2")]
    pub command: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct SceneInfo {
    #[prost(uint32, tag = "101")]
    pub request_type: u32,
    #[prost(uint32, tag = "102")]
    pub business_type: u32,
    #[prost(uint32, tag = "200")]
    pub scene_type: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct ClientMeta {
    #[prost(uint32, tag = "1")]
    pub agent_type: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct DownloadRkeyRequest {
    #[prost(int32, repeated, tag = "1")]
    pub types: Vec<i32>,
}

#[derive(Clone, PartialEq, Message)]
pub struct FetchRkeyResponse {
    #[prost(message, optional, tag = "4")]
    pub data: Option<RkeyData>,
}

#[derive(Clone, PartialEq, Message)]
pub struct RkeyData {
    #[prost(message, repeated, tag = "1")]
    pub rkeys: Vec<RkeyInfo>,
}

#[derive(Clone, PartialEq, Message)]
pub struct RkeyInfo {
    #[prost(string, tag = "1")]
    pub rkey: String,
    #[prost(uint64, tag = "2")]
    pub ttl: u64,
    #[prost(uint32, tag = "4")]
    pub created_at: u32,
    #[prost(uint32, tag = "5")]
    pub kind: u32,
}

pub fn fetch_rkey_packet() -> OidbEnvelope {
    let body = FetchRkeyRequest {
        request_head: Some(MultiMediaRequestHead {
            common: Some(CommonHead {
                request_id: 1,
                command: 202,
            }),
            scene: Some(SceneInfo {
                request_type: 2,
                business_type: 1,
                scene_type: 0,
            }),
            client: Some(ClientMeta { agent_type: 2 }),
        }),
        download_rkey: Some(DownloadRkeyRequest {
            types: vec![10, 20, 2],
        }),
    }
    .encode_to_vec();

    OidbEnvelope {
        command: 0x9067,
        sub_command: 202,
        error_code: 0,
        body,
        error_message: None,
        is_reserved: 1,
    }
}

pub fn decode_rkeys(bytes: &[u8]) -> Result<Vec<RkeyInfo>, DecodeRkeyError> {
    let envelope = OidbEnvelope::decode(bytes)?;
    if envelope.error_code != 0 {
        return Err(DecodeRkeyError::Oidb {
            code: envelope.error_code,
            message: envelope.error_message.unwrap_or_default(),
        });
    }
    let response = FetchRkeyResponse::decode(envelope.body.as_slice())?;
    Ok(response.data.map(|data| data.rkeys).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_rkey_request_has_stable_wire_shape() {
        let packet = fetch_rkey_packet();
        assert_eq!(packet.command, 0x9067);
        assert_eq!(packet.sub_command, 202);
        assert_eq!(
            hex(&packet.encode_to_vec()),
            "08e7a00210ca01221c0a130a05080110ca011206a80602b006011a02080222050a030a14026001"
        );
    }

    #[test]
    fn decodes_private_and_group_rkeys() {
        let response = FetchRkeyResponse {
            data: Some(RkeyData {
                rkeys: vec![
                    RkeyInfo {
                        rkey: "&rkey=private".into(),
                        ttl: 3600,
                        created_at: 10,
                        kind: 10,
                    },
                    RkeyInfo {
                        rkey: "&rkey=group".into(),
                        ttl: 7200,
                        created_at: 20,
                        kind: 20,
                    },
                ],
            }),
        };
        let envelope = OidbEnvelope {
            command: 0x9067,
            sub_command: 202,
            error_code: 0,
            body: response.encode_to_vec(),
            error_message: None,
            is_reserved: 1,
        };
        let result = decode_rkeys(&envelope.encode_to_vec()).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].kind, 10);
        assert_eq!(result[1].rkey, "&rkey=group");
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}
