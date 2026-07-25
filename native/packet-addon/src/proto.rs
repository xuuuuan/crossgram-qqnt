use prost::Message;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DecodeRkeyError {
    #[error(transparent)]
    Protobuf(#[from] prost::DecodeError),
    #[error("OIDB error {code}: {message}")]
    Oidb { code: u32, message: String },
}

pub type DecodePacketError = DecodeRkeyError;

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
    #[prost(message, optional, tag = "201")]
    pub c2c: Option<C2cUserInfo>,
    #[prost(message, optional, tag = "202")]
    pub group: Option<GroupInfo>,
}

#[derive(Clone, PartialEq, Message)]
pub struct C2cUserInfo {
    #[prost(uint32, tag = "1")]
    pub account_type: u32,
    #[prost(string, tag = "2")]
    pub target_uid: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct GroupInfo {
    #[prost(uint32, tag = "1")]
    pub group_uin: u32,
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

#[derive(Clone, PartialEq, Message)]
pub struct RichMediaDownloadRequest {
    #[prost(message, optional, tag = "1")]
    pub request_head: Option<MultiMediaRequestHead>,
    #[prost(message, optional, tag = "3")]
    pub download: Option<DownloadRequest>,
}

#[derive(Clone, PartialEq, Message)]
pub struct DownloadRequest {
    #[prost(message, optional, tag = "1")]
    pub node: Option<IndexNode>,
    #[prost(message, optional, tag = "2")]
    pub download: Option<DownloadExt>,
}

#[derive(Clone, PartialEq, Message)]
pub struct IndexNode {
    #[prost(string, tag = "2")]
    pub file_uuid: String,
    #[prost(uint32, tag = "3")]
    pub store_id: u32,
    #[prost(uint32, tag = "4")]
    pub upload_time: u32,
    #[prost(uint32, tag = "5")]
    pub ttl: u32,
    #[prost(uint32, tag = "6")]
    pub sub_type: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct DownloadExt {
    #[prost(message, optional, tag = "2")]
    pub video: Option<VideoDownloadExt>,
}

#[derive(Clone, PartialEq, Message)]
pub struct VideoDownloadExt {
    #[prost(uint32, tag = "1")]
    pub business_type: u32,
    #[prost(uint32, tag = "2")]
    pub scene_type: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct RichMediaDownloadResponse {
    #[prost(message, optional, tag = "1")]
    pub response_head: Option<MultiMediaResponseHead>,
    #[prost(message, optional, tag = "3")]
    pub download: Option<DownloadResponse>,
}

#[derive(Clone, PartialEq, Message)]
pub struct MultiMediaResponseHead {
    #[prost(uint32, tag = "2")]
    pub return_code: u32,
    #[prost(string, tag = "3")]
    pub message: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct DownloadResponse {
    #[prost(string, tag = "1")]
    pub rkey: String,
    #[prost(uint32, tag = "2")]
    pub ttl_seconds: u32,
    #[prost(message, optional, tag = "3")]
    pub info: Option<DownloadInfo>,
    #[prost(uint32, tag = "4")]
    pub created_at: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct DownloadInfo {
    #[prost(string, tag = "1")]
    pub domain: String,
    #[prost(string, tag = "2")]
    pub url_path: String,
    #[prost(uint32, tag = "3")]
    pub https_port: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct GroupFileRequest {
    #[prost(message, optional, tag = "3")]
    pub download: Option<GroupFileDownloadRequest>,
}

#[derive(Clone, PartialEq, Message)]
pub struct GroupFileDownloadRequest {
    #[prost(uint32, tag = "1")]
    pub group_uin: u32,
    #[prost(uint32, tag = "2")]
    pub app_id: u32,
    #[prost(uint32, tag = "3")]
    pub business_id: u32,
    #[prost(string, tag = "4")]
    pub file_id: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct GroupFileResponse {
    #[prost(message, optional, tag = "3")]
    pub download: Option<GroupFileDownloadResponse>,
}

#[derive(Clone, PartialEq, Message)]
pub struct GroupFileDownloadResponse {
    #[prost(int32, tag = "1")]
    pub return_code: i32,
    #[prost(string, tag = "2")]
    pub return_message: String,
    #[prost(string, tag = "3")]
    pub client_wording: String,
    #[prost(string, tag = "5")]
    pub download_dns: String,
    #[prost(bytes = "vec", tag = "6")]
    pub download_url: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct PrivateFileRequest {
    #[prost(uint32, tag = "1")]
    pub sub_command: u32,
    #[prost(int32, tag = "2")]
    pub field_2: i32,
    #[prost(message, optional, tag = "14")]
    pub body: Option<PrivateFileRequestBody>,
    #[prost(int32, tag = "101")]
    pub field_101: i32,
    #[prost(int32, tag = "102")]
    pub field_102: i32,
    #[prost(int32, tag = "200")]
    pub field_200: i32,
    #[prost(bytes = "vec", tag = "99999")]
    pub field_99999: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
pub struct PrivateFileRequestBody {
    #[prost(string, tag = "10")]
    pub receiver_uid: String,
    #[prost(string, tag = "20")]
    pub file_uuid: String,
    #[prost(int32, tag = "30")]
    pub kind: i32,
    #[prost(string, tag = "60")]
    pub file_hash: String,
    #[prost(int32, tag = "601")]
    pub field_601: i32,
}

#[derive(Clone, PartialEq, Message)]
pub struct PrivateFileResponse {
    #[prost(message, optional, tag = "14")]
    pub body: Option<PrivateFileResponseBody>,
}

#[derive(Clone, PartialEq, Message)]
pub struct PrivateFileResponseBody {
    #[prost(string, tag = "20")]
    pub state: String,
    #[prost(message, optional, tag = "30")]
    pub result: Option<PrivateFileResult>,
}

#[derive(Clone, PartialEq, Message)]
pub struct PrivateFileResult {
    #[prost(string, tag = "20")]
    pub server: String,
    #[prost(uint32, tag = "40")]
    pub port: u32,
    #[prost(string, tag = "50")]
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectUrl {
    pub url: String,
    pub ttl_seconds: u32,
    pub created_at: u32,
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
                c2c: None,
                group: None,
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

pub fn video_download_packet(
    chat_type: u32,
    peer: &str,
    self_uid: &str,
    file_uuid: &str,
) -> Result<OidbEnvelope, String> {
    let (command, scene_type, c2c, group) = match chat_type {
        1 => (
            0x11e9,
            1,
            Some(C2cUserInfo {
                account_type: 2,
                target_uid: self_uid.into(),
            }),
            None,
        ),
        2 => {
            let group_uin = peer
                .parse::<u32>()
                .map_err(|_| "QQ group peer must be a numeric UIN".to_string())?;
            (0x11ea, 2, None, Some(GroupInfo { group_uin }))
        }
        _ => return Err(format!("unsupported QQ chat type: {chat_type}")),
    };
    if file_uuid.is_empty() {
        return Err("QQ video file UUID must not be empty".into());
    }
    let body = RichMediaDownloadRequest {
        request_head: Some(MultiMediaRequestHead {
            common: Some(CommonHead {
                request_id: 1,
                command: 200,
            }),
            scene: Some(SceneInfo {
                request_type: 2,
                business_type: 2,
                scene_type,
                c2c,
                group,
            }),
            client: Some(ClientMeta { agent_type: 2 }),
        }),
        download: Some(DownloadRequest {
            node: Some(IndexNode {
                file_uuid: file_uuid.into(),
                store_id: 1,
                upload_time: 0,
                ttl: 0,
                sub_type: 0,
            }),
            download: Some(DownloadExt {
                video: Some(VideoDownloadExt {
                    business_type: 0,
                    scene_type: 0,
                }),
            }),
        }),
    }
    .encode_to_vec();
    Ok(OidbEnvelope {
        command,
        sub_command: 200,
        error_code: 0,
        body,
        error_message: None,
        is_reserved: 1,
    })
}

pub fn decode_video_download(bytes: &[u8]) -> Result<DirectUrl, DecodePacketError> {
    let body = decode_envelope(bytes)?;
    let response = RichMediaDownloadResponse::decode(body.as_slice())?;
    if let Some(head) = response.response_head {
        if head.return_code != 0 {
            return Err(DecodePacketError::Oidb {
                code: head.return_code,
                message: head.message,
            });
        }
    }
    let download = response.download.ok_or_else(|| DecodePacketError::Oidb {
        code: 0,
        message: "video response did not contain download info".into(),
    })?;
    let info = download.info.ok_or_else(|| DecodePacketError::Oidb {
        code: 0,
        message: "video response did not contain a CDN endpoint".into(),
    })?;
    if info.domain.is_empty() || info.url_path.is_empty() {
        return Err(DecodePacketError::Oidb {
            code: 0,
            message: "video CDN endpoint was empty".into(),
        });
    }
    let port = if info.https_port == 0 || info.https_port == 443 {
        String::new()
    } else {
        format!(":{}", info.https_port)
    };
    Ok(DirectUrl {
        url: format!(
            "https://{}{port}{}{}",
            info.domain, info.url_path, download.rkey
        ),
        ttl_seconds: download.ttl_seconds,
        created_at: download.created_at,
    })
}

pub fn group_file_download_packet(group: &str, file_uuid: &str) -> Result<OidbEnvelope, String> {
    let group_uin = group
        .parse::<u32>()
        .map_err(|_| "QQ group peer must be a numeric UIN".to_string())?;
    if file_uuid.is_empty() {
        return Err("QQ group file UUID must not be empty".into());
    }
    let body = GroupFileRequest {
        download: Some(GroupFileDownloadRequest {
            group_uin,
            app_id: 7,
            business_id: 102,
            file_id: file_uuid.into(),
        }),
    }
    .encode_to_vec();
    Ok(OidbEnvelope {
        command: 0x6d6,
        sub_command: 2,
        error_code: 0,
        body,
        error_message: None,
        is_reserved: 1,
    })
}

pub fn decode_group_file_download(bytes: &[u8]) -> Result<DirectUrl, DecodePacketError> {
    let body = decode_envelope(bytes)?;
    let response = GroupFileResponse::decode(body.as_slice())?
        .download
        .ok_or_else(|| DecodePacketError::Oidb {
            code: 0,
            message: "group file response did not contain download info".into(),
        })?;
    if response.return_code != 0 {
        return Err(DecodePacketError::Oidb {
            code: response.return_code as u32,
            message: if response.client_wording.is_empty() {
                response.return_message
            } else {
                response.client_wording
            },
        });
    }
    if response.download_dns.is_empty() || response.download_url.is_empty() {
        return Err(DecodePacketError::Oidb {
            code: 0,
            message: "group file CDN endpoint was empty".into(),
        });
    }
    Ok(DirectUrl {
        url: format!(
            "https://{}/ftn_handler/{}/?fname=",
            response.download_dns,
            hex(&response.download_url)
        ),
        ttl_seconds: 300,
        created_at: 0,
    })
}

pub fn private_file_download_packet(
    self_uid: &str,
    file_uuid: &str,
    file_hash: &str,
) -> Result<OidbEnvelope, String> {
    if self_uid.is_empty() || file_uuid.is_empty() || file_hash.is_empty() {
        return Err(
            "QQ private file direct URL requires self UID, file UUID, and 10 MiB MD5".into(),
        );
    }
    let body = PrivateFileRequest {
        sub_command: 1200,
        field_2: 1,
        body: Some(PrivateFileRequestBody {
            receiver_uid: self_uid.into(),
            file_uuid: file_uuid.into(),
            kind: 2,
            file_hash: file_hash.into(),
            field_601: 0,
        }),
        field_101: 3,
        field_102: 103,
        field_200: 1,
        field_99999: vec![0xc0, 0x85, 0x2c, 0x01],
    }
    .encode_to_vec();
    Ok(OidbEnvelope {
        command: 0xe37,
        sub_command: 1200,
        error_code: 0,
        body,
        error_message: None,
        is_reserved: 0,
    })
}

pub fn decode_private_file_download(bytes: &[u8]) -> Result<DirectUrl, DecodePacketError> {
    let body = decode_envelope(bytes)?;
    let response = PrivateFileResponse::decode(body.as_slice())?
        .body
        .ok_or_else(|| DecodePacketError::Oidb {
            code: 0,
            message: "private file response did not contain a body".into(),
        })?;
    let result = response.result.ok_or_else(|| DecodePacketError::Oidb {
        code: 0,
        message: if response.state.is_empty() {
            "private file response did not contain download info".into()
        } else {
            response.state
        },
    })?;
    if result.server.is_empty() || result.url.len() < 8 {
        return Err(DecodePacketError::Oidb {
            code: 0,
            message: "private file CDN endpoint was empty".into(),
        });
    }
    let port = if result.port == 0 || result.port == 80 {
        String::new()
    } else {
        format!(":{}", result.port)
    };
    Ok(DirectUrl {
        url: format!(
            "http://{}{port}{}&isthumb=0",
            result.server,
            &result.url[8..]
        ),
        ttl_seconds: 300,
        created_at: 0,
    })
}

fn decode_envelope(bytes: &[u8]) -> Result<Vec<u8>, DecodePacketError> {
    let envelope = OidbEnvelope::decode(bytes)?;
    if envelope.error_code != 0 {
        return Err(DecodePacketError::Oidb {
            code: envelope.error_code,
            message: envelope.error_message.unwrap_or_default(),
        });
    }
    Ok(envelope.body)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
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

    #[test]
    fn builds_private_and_group_video_download_requests() {
        let private = video_download_packet(1, "peer-uid", "self-uid", "video-uuid").unwrap();
        assert_eq!(private.command, 0x11e9);
        let request = RichMediaDownloadRequest::decode(private.body.as_slice()).unwrap();
        let scene = request.request_head.unwrap().scene.unwrap();
        assert_eq!(scene.scene_type, 1);
        assert_eq!(scene.c2c.unwrap().target_uid, "self-uid");
        assert_eq!(
            request.download.unwrap().node.unwrap().file_uuid,
            "video-uuid"
        );

        let group = video_download_packet(2, "1002974327", "self-uid", "group-video").unwrap();
        assert_eq!(group.command, 0x11ea);
        let request = RichMediaDownloadRequest::decode(group.body.as_slice()).unwrap();
        let scene = request.request_head.unwrap().scene.unwrap();
        assert_eq!(scene.scene_type, 2);
        assert_eq!(scene.group.unwrap().group_uin, 1_002_974_327);
        assert!(scene.c2c.is_none());
    }

    #[test]
    fn decodes_video_url_and_server_ttl() {
        let response = RichMediaDownloadResponse {
            response_head: Some(MultiMediaResponseHead {
                return_code: 0,
                message: String::new(),
            }),
            download: Some(DownloadResponse {
                rkey: "&rkey=fresh".into(),
                ttl_seconds: 600,
                info: Some(DownloadInfo {
                    domain: "video.qq.example".into(),
                    url_path: "/download/video".into(),
                    https_port: 443,
                }),
                created_at: 1_800_000_000,
            }),
        };
        let envelope = OidbEnvelope {
            command: 0x11ea,
            sub_command: 200,
            error_code: 0,
            body: response.encode_to_vec(),
            error_message: None,
            is_reserved: 1,
        };
        assert_eq!(
            decode_video_download(&envelope.encode_to_vec()).unwrap(),
            DirectUrl {
                url: "https://video.qq.example/download/video&rkey=fresh".into(),
                ttl_seconds: 600,
                created_at: 1_800_000_000,
            }
        );
    }

    #[test]
    fn builds_and_decodes_group_file_download() {
        let request = group_file_download_packet("1002974327", "group-file-uuid").unwrap();
        assert_eq!((request.command, request.sub_command), (0x6d6, 2));
        let body = GroupFileRequest::decode(request.body.as_slice())
            .unwrap()
            .download
            .unwrap();
        assert_eq!(
            (body.group_uin, body.app_id, body.business_id),
            (1_002_974_327, 7, 102)
        );
        assert_eq!(body.file_id, "group-file-uuid");

        let response = GroupFileResponse {
            download: Some(GroupFileDownloadResponse {
                return_code: 0,
                return_message: String::new(),
                client_wording: String::new(),
                download_dns: "group-file.qq.example".into(),
                download_url: vec![0x00, 0xab, 0xff],
            }),
        };
        let envelope = OidbEnvelope {
            command: 0x6d6,
            sub_command: 2,
            error_code: 0,
            body: response.encode_to_vec(),
            error_message: None,
            is_reserved: 1,
        };
        assert_eq!(
            decode_group_file_download(&envelope.encode_to_vec())
                .unwrap()
                .url,
            "https://group-file.qq.example/ftn_handler/00abff/?fname="
        );
    }

    #[test]
    fn builds_and_decodes_private_file_download() {
        let request =
            private_file_download_packet("self-uid", "private-file-uuid", "10m-md5").unwrap();
        assert_eq!(
            (request.command, request.sub_command, request.is_reserved),
            (0xe37, 1200, 0)
        );
        let body = PrivateFileRequest::decode(request.body.as_slice()).unwrap();
        assert_eq!(body.body.as_ref().unwrap().receiver_uid, "self-uid");
        assert_eq!(body.body.as_ref().unwrap().file_hash, "10m-md5");
        assert_eq!(body.field_99999, vec![0xc0, 0x85, 0x2c, 0x01]);

        let response = PrivateFileResponse {
            body: Some(PrivateFileResponseBody {
                state: "ok".into(),
                result: Some(PrivateFileResult {
                    server: "private-file.qq.example".into(),
                    port: 8080,
                    url: "https:///download/private?token=fresh".into(),
                }),
            }),
        };
        let envelope = OidbEnvelope {
            command: 0xe37,
            sub_command: 1200,
            error_code: 0,
            body: response.encode_to_vec(),
            error_message: None,
            is_reserved: 0,
        };
        assert_eq!(
            decode_private_file_download(&envelope.encode_to_vec())
                .unwrap()
                .url,
            "http://private-file.qq.example:8080/download/private?token=fresh&isthumb=0"
        );
    }

    #[test]
    fn rejects_invalid_direct_url_requests_and_protocol_errors() {
        assert!(video_download_packet(2, "not-a-group", "self", "uuid").is_err());
        assert!(group_file_download_packet("100", "").is_err());
        assert!(private_file_download_packet("self", "uuid", "").is_err());
        let envelope = OidbEnvelope {
            command: 0x11ea,
            sub_command: 200,
            error_code: 170013002,
            body: Vec::new(),
            error_message: Some("rate limited".into()),
            is_reserved: 1,
        };
        assert!(
            decode_video_download(&envelope.encode_to_vec())
                .unwrap_err()
                .to_string()
                .contains("rate limited")
        );
    }
}
