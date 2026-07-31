#![allow(dead_code)] // QRTC profiles intentionally remain disabled until host lifecycle verification.

use getrandom::fill;
use std::{
    collections::HashMap,
    marker::PhantomData,
    sync::{Arc, Mutex, OnceLock},
    thread::ThreadId,
};
use subtle::ConstantTimeEq;

/// A profile admits a QRTC receiver only when every observed module value
/// matches exactly. No production profile is enabled until host lifecycle
/// evidence exists.
#[derive(Clone, Copy)]
pub(crate) struct QrtcProfile {
    pub module_name: &'static str,
    pub build_id: &'static [u8],
    pub sha256: [u8; 32],
    pub receiver_fingerprint: &'static [u8],
}

#[derive(Clone)]
pub(crate) struct ModuleIdentity {
    module_name: String,
    build_id: Vec<u8>,
    sha256: [u8; 32],
    receiver_fingerprint: Vec<u8>,
}

impl ModuleIdentity {
    pub(crate) fn new(
        module_name: impl Into<String>,
        build_id: impl Into<Vec<u8>>,
        sha256: [u8; 32],
        receiver_fingerprint: impl Into<Vec<u8>>,
    ) -> Self {
        Self {
            module_name: module_name.into(),
            build_id: build_id.into(),
            sha256,
            receiver_fingerprint: receiver_fingerprint.into(),
        }
    }
}

const QRTC_PROFILES: &[QrtcProfile] = &[];
const MAX_OUTSTANDING_CAPABILITIES_PER_RECEIVER_EPOCH: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QrtcStatus {
    Available,
    Unsupported,
    Expired,
    WrongThread,
    Closed,
    Invalid,
    Unavailable,
}

impl QrtcStatus {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Unsupported => "unsupported",
            Self::Expired => "expired",
            Self::WrongThread => "wrong-thread",
            Self::Closed => "closed",
            Self::Invalid => "invalid",
            Self::Unavailable => "unavailable",
        }
    }
}

const MAX_IN_FLIGHT_QRTC_ENTRIES: u32 = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QrtcLifecycle {
    Active,
    Closing,
    Destroyed,
}

impl QrtcLifecycle {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Closing => "closing",
            Self::Destroyed => "destroyed",
        }
    }
}

/// The only QRTC runtime data which may leave the native process. It has no
/// identifiers, native references, module data, call data, or payloads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct QrtcMetadataSnapshot {
    pub lifecycle: QrtcLifecycle,
    pub same_thread: bool,
    pub in_flight: u32,
    pub shutdown_was_idle: bool,
}

struct QrtcMetadataState {
    owner_thread: Option<ThreadId>,
    lifecycle: QrtcLifecycle,
    in_flight: u32,
    shutdown_was_idle: bool,
}

struct QrtcMetadataInner {
    profiles: &'static [QrtcProfile],
    identity: ModuleIdentity,
    state: Mutex<QrtcMetadataState>,
}

/// Profile-gated lifecycle accounting around a future native QRTC entry.
/// The registration thread stays private and is reduced to a boolean snapshot.
#[derive(Clone)]
pub(crate) struct QrtcMetadataProbe {
    inner: Arc<QrtcMetadataInner>,
}

pub(crate) struct QrtcEntry {
    inner: Arc<QrtcMetadataInner>,
    _not_send: PhantomData<*mut ()>,
}

impl QrtcMetadataProbe {
    pub(crate) fn new(profiles: &'static [QrtcProfile], identity: ModuleIdentity) -> Self {
        Self {
            inner: Arc::new(QrtcMetadataInner {
                profiles,
                identity,
                state: Mutex::new(QrtcMetadataState {
                    owner_thread: None,
                    lifecycle: QrtcLifecycle::Destroyed,
                    in_flight: 0,
                    shutdown_was_idle: false,
                }),
            }),
        }
    }

    pub(crate) fn register(&self) -> QrtcStatus {
        let mut state = match self.inner.state.lock() {
            Ok(state) => state,
            Err(_) => return QrtcStatus::Unavailable,
        };
        if !self.profile_matches() {
            return QrtcStatus::Unsupported;
        }
        if state.lifecycle == QrtcLifecycle::Closing {
            return QrtcStatus::Closed;
        }
        if let Some(owner_thread) = state.owner_thread
            && owner_thread != std::thread::current().id()
        {
            return QrtcStatus::WrongThread;
        }
        state.owner_thread = Some(std::thread::current().id());
        state.lifecycle = QrtcLifecycle::Active;
        state.in_flight = 0;
        state.shutdown_was_idle = false;
        QrtcStatus::Available
    }

    pub(crate) fn enter(&self) -> Result<QrtcEntry, QrtcStatus> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| QrtcStatus::Unavailable)?;
        let same_thread = state.owner_thread == Some(std::thread::current().id());
        if !same_thread {
            return Err(QrtcStatus::WrongThread);
        }
        if state.lifecycle != QrtcLifecycle::Active {
            return Err(QrtcStatus::Closed);
        }
        if state.in_flight >= MAX_IN_FLIGHT_QRTC_ENTRIES {
            return Err(QrtcStatus::Unavailable);
        }
        state.in_flight += 1;
        Ok(QrtcEntry {
            inner: Arc::clone(&self.inner),
            _not_send: PhantomData,
        })
    }

    /// Begins teardown from any thread. It never releases a receiver; the
    /// attaching thread must finalize after all admitted entries have drained.
    pub(crate) fn begin_shutdown(&self) -> QrtcStatus {
        let mut state = match self.inner.state.lock() {
            Ok(state) => state,
            Err(_) => return QrtcStatus::Unavailable,
        };
        if state.lifecycle == QrtcLifecycle::Destroyed {
            return QrtcStatus::Closed;
        }
        if state.lifecycle == QrtcLifecycle::Active {
            state.lifecycle = QrtcLifecycle::Closing;
            state.shutdown_was_idle = state.in_flight == 0;
        }
        QrtcStatus::Closed
    }

    /// Completes teardown only on the registration thread after entries drain.
    pub(crate) fn shutdown(&self) -> QrtcStatus {
        let owner_thread = self
            .inner
            .state
            .lock()
            .map(|state| state.owner_thread)
            .unwrap_or(None);
        if owner_thread.is_some() && owner_thread != Some(std::thread::current().id()) {
            return QrtcStatus::WrongThread;
        }
        if self.begin_shutdown() != QrtcStatus::Closed {
            return QrtcStatus::Unavailable;
        }
        self.finalize_shutdown()
    }

    fn finalize_shutdown(&self) -> QrtcStatus {
        let mut state = match self.inner.state.lock() {
            Ok(state) => state,
            Err(_) => return QrtcStatus::Unavailable,
        };
        if state.owner_thread.is_some() && state.owner_thread != Some(std::thread::current().id()) {
            return QrtcStatus::WrongThread;
        }
        if state.lifecycle == QrtcLifecycle::Closing && state.in_flight == 0 {
            state.lifecycle = QrtcLifecycle::Destroyed;
            state.owner_thread = None;
        }
        QrtcStatus::Closed
    }

    pub(crate) fn snapshot(&self) -> QrtcMetadataSnapshot {
        let current_thread = std::thread::current().id();
        let state = match self.inner.state.lock() {
            Ok(state) => state,
            Err(_) => {
                return QrtcMetadataSnapshot {
                    lifecycle: QrtcLifecycle::Destroyed,
                    same_thread: false,
                    in_flight: 0,
                    shutdown_was_idle: false,
                };
            }
        };
        QrtcMetadataSnapshot {
            lifecycle: state.lifecycle,
            same_thread: state.owner_thread == Some(current_thread),
            in_flight: state.in_flight,
            shutdown_was_idle: state.shutdown_was_idle,
        }
    }

    fn profile_matches(&self) -> bool {
        self.inner.profiles.iter().any(|profile| {
            profile.module_name == self.inner.identity.module_name
                && profile.build_id == self.inner.identity.build_id
                && profile.sha256 == self.inner.identity.sha256
                && profile.receiver_fingerprint == self.inner.identity.receiver_fingerprint
        })
    }
}

impl Drop for QrtcEntry {
    fn drop(&mut self) {
        let Ok(mut state) = self.inner.state.lock() else {
            return;
        };
        state.in_flight = state.in_flight.saturating_sub(1);
    }
}

pub(crate) struct CapabilityResult {
    pub status: QrtcStatus,
    pub token: Option<String>,
}

impl CapabilityResult {
    fn status(status: QrtcStatus) -> Self {
        Self {
            status,
            token: None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct CapabilityToken([u8; 32]);

impl CapabilityToken {
    fn random() -> Result<Self, QrtcStatus> {
        let mut bytes = [0; 32];
        fill(&mut bytes).map_err(|_| QrtcStatus::Unavailable)?;
        Ok(Self(bytes))
    }

    fn opaque(self) -> String {
        let mut value = String::with_capacity(self.0.len() * 2);
        for byte in self.0 {
            use std::fmt::Write;
            let _ = write!(value, "{byte:02x}");
        }
        value
    }

    fn parse(value: &str) -> Option<Self> {
        if value.len() != 64 {
            return None;
        }

        let mut bytes = [0; 32];
        for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
            bytes[index] = (hex_value(pair[0])? << 4) | hex_value(pair[1])?;
        }
        Some(Self(bytes))
    }
}

fn hex_value(character: u8) -> Option<u8> {
    match character {
        b'0'..=b'9' => Some(character - b'0'),
        b'a'..=b'f' => Some(character - b'a' + 10),
        b'A'..=b'F' => Some(character - b'A' + 10),
        _ => None,
    }
}

struct ReceiverSlot<C> {
    receiver: Option<C>,
    epoch: u64,
    owner_thread: ThreadId,
    live: bool,
}

impl<C> ReceiverSlot<C> {
    fn new(receiver: C, epoch: u64) -> Self {
        Self {
            receiver: Some(receiver),
            epoch,
            owner_thread: std::thread::current().id(),
            live: true,
        }
    }

    fn invalidate(&mut self) {
        self.live = false;
        self.receiver = None;
    }
}

struct CapabilityLease {
    epoch: u64,
    owner_thread: ThreadId,
}

/// Owns a native receiver without exposing, cloning, or serializing it.
/// Capabilities only identify a live slot in this process and are invalidated
/// whenever its native lifetime ends.
pub(crate) struct CapabilityService<C> {
    profiles: &'static [QrtcProfile],
    identity: ModuleIdentity,
    metadata: QrtcMetadataProbe,
    receiver: Option<ReceiverSlot<C>>,
    capabilities: HashMap<CapabilityToken, CapabilityLease>,
    epoch: u64,
    closed: bool,
}

impl<C> CapabilityService<C> {
    pub(crate) fn new(profiles: &'static [QrtcProfile], identity: ModuleIdentity) -> Self {
        Self {
            profiles,
            metadata: QrtcMetadataProbe::new(profiles, identity.clone()),
            identity,
            receiver: None,
            capabilities: HashMap::new(),
            epoch: 1,
            closed: false,
        }
    }

    pub(crate) fn attach(&mut self, receiver: C) -> QrtcStatus {
        if self.closed {
            return QrtcStatus::Closed;
        }
        if !self.profile_matches() {
            return QrtcStatus::Unsupported;
        }
        if self.receiver.is_some() {
            let status = self.begin_receiver_shutdown();
            if status != QrtcStatus::Closed {
                return status;
            }
            if self.receiver.is_some() {
                return QrtcStatus::Closed;
            }
        }
        self.clear_capabilities();
        let status = self.metadata.register();
        if status != QrtcStatus::Available {
            return status;
        }
        self.receiver = Some(ReceiverSlot::new(receiver, self.epoch));
        QrtcStatus::Available
    }

    pub(crate) fn request(&mut self) -> CapabilityResult {
        if self.closed {
            return CapabilityResult::status(QrtcStatus::Closed);
        }
        if !self.profile_matches() {
            return CapabilityResult::status(QrtcStatus::Unsupported);
        }
        let Some(receiver) = self.receiver.as_ref() else {
            return CapabilityResult::status(QrtcStatus::Expired);
        };
        if receiver.owner_thread != std::thread::current().id() {
            return CapabilityResult::status(QrtcStatus::WrongThread);
        }
        if !receiver.live || receiver.receiver.is_none() {
            return CapabilityResult::status(QrtcStatus::Expired);
        }
        let _entry = match self.metadata.enter() {
            Ok(entry) => entry,
            Err(status) => return CapabilityResult::status(status),
        };
        if self
            .capabilities
            .values()
            .filter(|lease| lease.epoch == receiver.epoch)
            .count()
            >= MAX_OUTSTANDING_CAPABILITIES_PER_RECEIVER_EPOCH
        {
            return CapabilityResult::status(QrtcStatus::Unavailable);
        }

        loop {
            let token = match CapabilityToken::random() {
                Ok(token) => token,
                Err(status) => return CapabilityResult::status(status),
            };
            if self.capabilities.contains_key(&token) {
                continue;
            }
            self.capabilities.insert(
                token,
                CapabilityLease {
                    epoch: receiver.epoch,
                    owner_thread: receiver.owner_thread,
                },
            );
            return CapabilityResult {
                status: QrtcStatus::Available,
                token: Some(token.opaque()),
            };
        }
    }

    pub(crate) fn status_for(&self, token: &str) -> QrtcStatus {
        if self.closed {
            return QrtcStatus::Closed;
        }
        let Some(token) = CapabilityToken::parse(token) else {
            return QrtcStatus::Invalid;
        };
        let mut matching_lease = None;
        for (candidate, lease) in &self.capabilities {
            if candidate.0.ct_eq(&token.0).unwrap_u8() == 1 {
                matching_lease = Some(lease);
            }
        }
        let Some(lease) = matching_lease else {
            return QrtcStatus::Invalid;
        };
        if lease.owner_thread != std::thread::current().id() {
            return QrtcStatus::WrongThread;
        }
        let Some(receiver) = self.receiver.as_ref() else {
            return QrtcStatus::Expired;
        };
        if !receiver.live || receiver.epoch != lease.epoch {
            return QrtcStatus::Expired;
        }
        QrtcStatus::Available
    }

    pub(crate) fn terminal(&mut self) -> QrtcStatus {
        self.begin_receiver_shutdown()
    }

    pub(crate) fn detach_session(&mut self) -> QrtcStatus {
        match self.begin_receiver_shutdown() {
            QrtcStatus::Closed => QrtcStatus::Expired,
            status => status,
        }
    }

    pub(crate) fn close(&mut self) -> QrtcStatus {
        if self.closed && self.receiver.is_none() {
            return QrtcStatus::Closed;
        }
        self.closed = true;
        self.begin_receiver_shutdown()
    }

    /// Revokes every capability before closing from any thread. Receiver
    /// destruction stays on the attaching thread after entries have drained.
    fn begin_receiver_shutdown(&mut self) -> QrtcStatus {
        self.clear_capabilities();
        let status = self.metadata.begin_shutdown();
        if status != QrtcStatus::Closed {
            return status;
        }
        if let Some(receiver) = self.receiver.as_ref()
            && receiver.owner_thread != std::thread::current().id()
        {
            return QrtcStatus::WrongThread;
        }
        self.finalize_receiver_shutdown()
    }

    fn finalize_receiver_shutdown(&mut self) -> QrtcStatus {
        let snapshot = self.metadata.snapshot();
        if snapshot.in_flight != 0 {
            return QrtcStatus::Closed;
        }
        let status = self.metadata.finalize_shutdown();
        if status == QrtcStatus::Closed {
            self.invalidate_receiver();
        }
        status
    }

    pub(crate) fn metadata_snapshot(&self) -> QrtcMetadataSnapshot {
        self.metadata.snapshot()
    }

    fn profile_matches(&self) -> bool {
        self.profiles.iter().any(|profile| {
            profile.module_name == self.identity.module_name
                && profile.build_id == self.identity.build_id
                && profile.sha256 == self.identity.sha256
                && profile.receiver_fingerprint == self.identity.receiver_fingerprint
        })
    }

    fn clear_capabilities(&mut self) {
        for (mut token, _) in self.capabilities.drain() {
            token.0.fill(0);
        }
    }

    fn invalidate_receiver(&mut self) {
        self.clear_capabilities();
        let Some(mut receiver) = self.receiver.take() else {
            return;
        };
        receiver.invalidate();
        self.epoch = self.epoch.wrapping_add(1).max(1);
    }
}

impl<C> Drop for CapabilityService<C> {
    fn drop(&mut self) {
        self.clear_capabilities();
        let _ = self.metadata.begin_shutdown();
        let owner_thread = self.receiver.as_ref().map(|receiver| receiver.owner_thread);
        if owner_thread == Some(std::thread::current().id())
            && self.metadata.snapshot().in_flight == 0
            && self.metadata.finalize_shutdown() == QrtcStatus::Closed
        {
            self.invalidate_receiver();
            return;
        }
        if let Some(receiver) = self.receiver.take() {
            // No safe owner/drain boundary remains after Drop. Leak rather than
            // destroy an opaque native receiver on the wrong thread or in flight.
            std::mem::forget(receiver);
        }
    }
}

fn addon_metadata_probe() -> &'static Mutex<QrtcMetadataProbe> {
    static METADATA: OnceLock<Mutex<QrtcMetadataProbe>> = OnceLock::new();
    METADATA.get_or_init(|| {
        Mutex::new(QrtcMetadataProbe::new(
            QRTC_PROFILES,
            ModuleIdentity::new("", [], [0; 32], []),
        ))
    })
}

pub(crate) fn addon_metadata_snapshot() -> QrtcMetadataSnapshot {
    addon_metadata_probe()
        .lock()
        .map(|probe| probe.snapshot())
        .unwrap_or(QrtcMetadataSnapshot {
            lifecycle: QrtcLifecycle::Destroyed,
            same_thread: false,
            in_flight: 0,
            shutdown_was_idle: false,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashSet,
        sync::{
            Arc, Barrier, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        thread,
    };

    const PROFILE: QrtcProfile = QrtcProfile {
        module_name: "qqnt-qrtc.node",
        build_id: &[0x01, 0x02],
        sha256: [0x03; 32],
        receiver_fingerprint: &[0x04, 0x05],
    };

    struct FakeContext(Arc<AtomicUsize>);

    impl Drop for FakeContext {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn service(dropped: Arc<AtomicUsize>) -> CapabilityService<FakeContext> {
        let mut service = CapabilityService::new(
            &[PROFILE],
            ModuleIdentity::new("qqnt-qrtc.node", [0x01, 0x02], [0x03; 32], [0x04, 0x05]),
        );
        assert_eq!(service.attach(FakeContext(dropped)), QrtcStatus::Available);
        service
    }

    #[test]
    fn fails_closed_for_a_wrong_module_profile() {
        let mut service = CapabilityService::new(
            &[PROFILE],
            ModuleIdentity::new("wrong.node", [0x01, 0x02], [0x03; 32], [0x04, 0x05]),
        );
        assert_eq!(
            service.attach(FakeContext(Arc::new(AtomicUsize::new(0)))),
            QrtcStatus::Unsupported
        );
        assert_eq!(service.request().status, QrtcStatus::Unsupported);
    }

    #[test]
    fn confines_capabilities_to_the_owner_thread() {
        let service = Arc::new(Mutex::new(service(Arc::new(AtomicUsize::new(0)))));
        let worker = Arc::clone(&service);
        let status = thread::spawn(move || worker.lock().unwrap().request().status)
            .join()
            .unwrap();
        assert_eq!(status, QrtcStatus::WrongThread);
    }

    #[test]
    fn strictly_parses_exactly_64_hex_token_characters() {
        let mut service = service(Arc::new(AtomicUsize::new(0)));
        let token = service.request().token.expect("capability token");
        assert_eq!(service.status_for(&token), QrtcStatus::Available);
        assert_eq!(
            service.status_for(&token.to_uppercase()),
            QrtcStatus::Available
        );

        for malformed in [
            String::new(),
            "0".repeat(63),
            "0".repeat(65),
            format!("0x{}", "0".repeat(62)),
            format!("{}g", "0".repeat(63)),
        ] {
            assert_eq!(service.status_for(&malformed), QrtcStatus::Invalid);
        }
    }

    #[test]
    fn rejects_a_well_formed_nonmatching_token() {
        let mut service = service(Arc::new(AtomicUsize::new(0)));
        let token = service.request().token.expect("capability token");
        let nonmatch = format!(
            "{}{}",
            if token.starts_with('0') { "1" } else { "0" },
            &token[1..]
        );
        assert_eq!(service.status_for(&nonmatch), QrtcStatus::Invalid);
    }

    #[test]
    fn mints_non_reused_opaque_tokens() {
        let mut service = service(Arc::new(AtomicUsize::new(0)));
        let tokens: HashSet<_> = (0..MAX_OUTSTANDING_CAPABILITIES_PER_RECEIVER_EPOCH)
            .map(|_| service.request().token.expect("capability token"))
            .collect();
        assert_eq!(
            tokens.len(),
            MAX_OUTSTANDING_CAPABILITIES_PER_RECEIVER_EPOCH
        );
        assert!(tokens.iter().all(|token| token.len() == 64));
    }

    #[test]
    fn rejects_requests_above_the_per_receiver_epoch_limit() {
        let mut service = service(Arc::new(AtomicUsize::new(0)));
        for _ in 0..MAX_OUTSTANDING_CAPABILITIES_PER_RECEIVER_EPOCH {
            assert_eq!(service.request().status, QrtcStatus::Available);
        }
        assert_eq!(service.request().status, QrtcStatus::Unavailable);
    }

    #[test]
    fn concurrent_requests_fail_closed_outside_the_owner_thread() {
        let service = Arc::new(Mutex::new(service(Arc::new(AtomicUsize::new(0)))));
        let barrier = Arc::new(Barrier::new(9));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let service = Arc::clone(&service);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    service.lock().unwrap().request().status
                })
            })
            .collect();
        barrier.wait();
        for worker in workers {
            assert_eq!(worker.join().unwrap(), QrtcStatus::WrongThread);
        }
        assert_eq!(
            service.lock().unwrap().request().status,
            QrtcStatus::Available
        );
    }

    #[test]
    fn invalidation_is_idempotent_and_drops_the_native_context_once() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let mut service = service(Arc::clone(&dropped));
        let token = service.request().token.expect("capability token");
        service.terminal();
        service.terminal();
        service.detach_session();
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert_eq!(service.status_for(&token), QrtcStatus::Invalid);
    }

    #[test]
    fn cross_thread_terminal_revokes_capabilities_before_owner_thread_drain() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let service = Arc::new(Mutex::new(service(Arc::clone(&dropped))));
        let token = service
            .lock()
            .unwrap()
            .request()
            .token
            .expect("capability token");

        let worker = Arc::clone(&service);
        assert_eq!(
            thread::spawn(move || worker.lock().unwrap().terminal())
                .join()
                .unwrap(),
            QrtcStatus::WrongThread
        );
        let guard = service.lock().unwrap();
        assert_eq!(guard.status_for(&token), QrtcStatus::Invalid);
        assert_eq!(guard.metadata_snapshot().lifecycle, QrtcLifecycle::Closing);
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
        drop(guard);

        assert_eq!(service.lock().unwrap().terminal(), QrtcStatus::Closed);
        assert_eq!(
            service.lock().unwrap().status_for(&token),
            QrtcStatus::Invalid
        );
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cross_thread_close_revokes_capabilities_before_owner_thread_drain() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let service = Arc::new(Mutex::new(service(Arc::clone(&dropped))));
        let token = service
            .lock()
            .unwrap()
            .request()
            .token
            .expect("capability token");

        let worker = Arc::clone(&service);
        assert_eq!(
            thread::spawn(move || worker.lock().unwrap().close())
                .join()
                .unwrap(),
            QrtcStatus::WrongThread
        );
        let guard = service.lock().unwrap();
        assert!(guard.capabilities.is_empty());
        assert_eq!(guard.status_for(&token), QrtcStatus::Closed);
        assert_eq!(guard.metadata_snapshot().lifecycle, QrtcLifecycle::Closing);
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
        drop(guard);

        assert_eq!(service.lock().unwrap().close(), QrtcStatus::Closed);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn reattach_advances_epoch_and_removes_prior_capabilities() {
        let first_dropped = Arc::new(AtomicUsize::new(0));
        let second_dropped = Arc::new(AtomicUsize::new(0));
        let mut service = service(Arc::clone(&first_dropped));
        let token = service.request().token.expect("capability token");

        assert_eq!(service.terminal(), QrtcStatus::Closed);
        assert_eq!(first_dropped.load(Ordering::SeqCst), 1);
        assert_eq!(
            service.attach(FakeContext(Arc::clone(&second_dropped))),
            QrtcStatus::Available
        );
        assert_eq!(service.status_for(&token), QrtcStatus::Invalid);
        assert_eq!(service.request().status, QrtcStatus::Available);
        assert_eq!(second_dropped.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn reattach_waits_for_in_flight_entries_before_releasing_receiver() {
        let first_dropped = Arc::new(AtomicUsize::new(0));
        let rejected_dropped = Arc::new(AtomicUsize::new(0));
        let next_dropped = Arc::new(AtomicUsize::new(0));
        let mut service = service(Arc::clone(&first_dropped));
        let entry = service.metadata.enter().expect("same-thread entry");

        assert_eq!(service.terminal(), QrtcStatus::Closed);
        assert_eq!(
            service.metadata_snapshot().lifecycle,
            QrtcLifecycle::Closing
        );
        assert_eq!(service.metadata_snapshot().in_flight, 1);
        assert_eq!(first_dropped.load(Ordering::SeqCst), 0);
        assert_eq!(
            service.attach(FakeContext(Arc::clone(&rejected_dropped))),
            QrtcStatus::Closed
        );
        assert_eq!(first_dropped.load(Ordering::SeqCst), 0);
        assert_eq!(rejected_dropped.load(Ordering::SeqCst), 1);

        drop(entry);
        assert_eq!(
            service.attach(FakeContext(Arc::clone(&next_dropped))),
            QrtcStatus::Available
        );
        assert_eq!(first_dropped.load(Ordering::SeqCst), 1);
        assert_eq!(next_dropped.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn terminal_clears_capabilities_on_each_epoch() {
        let dropped = Arc::new(AtomicUsize::new(0));
        let mut service = service(Arc::clone(&dropped));
        for _ in 0..3 {
            for _ in 0..MAX_OUTSTANDING_CAPABILITIES_PER_RECEIVER_EPOCH {
                assert_eq!(service.request().status, QrtcStatus::Available);
            }
            assert_eq!(
                service.capabilities.len(),
                MAX_OUTSTANDING_CAPABILITIES_PER_RECEIVER_EPOCH
            );
            assert_eq!(service.terminal(), QrtcStatus::Closed);
            assert!(service.capabilities.is_empty());
            assert_eq!(
                service.attach(FakeContext(Arc::clone(&dropped))),
                QrtcStatus::Available
            );
        }
    }

    #[test]
    fn destructor_session_detach_and_addon_close_invalidate_capabilities() {
        let detached_dropped = Arc::new(AtomicUsize::new(0));
        let mut detached = service(Arc::clone(&detached_dropped));
        let token = detached.request().token.expect("capability token");
        detached.detach_session();
        assert_eq!(detached.status_for(&token), QrtcStatus::Invalid);
        assert_eq!(detached_dropped.load(Ordering::SeqCst), 1);

        let closed_dropped = Arc::new(AtomicUsize::new(0));
        let mut closed = service(Arc::clone(&closed_dropped));
        let token = closed.request().token.expect("capability token");
        closed.close();
        closed.close();
        assert_eq!(closed.status_for(&token), QrtcStatus::Closed);
        assert_eq!(closed_dropped.load(Ordering::SeqCst), 1);

        let destructor_dropped = Arc::new(AtomicUsize::new(0));
        {
            let mut dropped_service = service(Arc::clone(&destructor_dropped));
            let _ = dropped_service.request();
        }
        assert_eq!(destructor_dropped.load(Ordering::SeqCst), 1);
    }

    fn metadata_probe() -> QrtcMetadataProbe {
        QrtcMetadataProbe::new(
            &[PROFILE],
            ModuleIdentity::new("qqnt-qrtc.node", [0x01, 0x02], [0x03; 32], [0x04, 0x05]),
        )
    }

    #[test]
    fn metadata_probe_is_profile_gated_and_exposes_only_fixed_safe_values() {
        let unsupported = QrtcMetadataProbe::new(
            &[],
            ModuleIdentity::new("qqnt-qrtc.node", [0x01, 0x02], [0x03; 32], [0x04, 0x05]),
        );
        assert_eq!(unsupported.register(), QrtcStatus::Unsupported);
        assert_eq!(
            unsupported.snapshot(),
            QrtcMetadataSnapshot {
                lifecycle: QrtcLifecycle::Destroyed,
                same_thread: false,
                in_flight: 0,
                shutdown_was_idle: false,
            }
        );

        let probe = metadata_probe();
        assert_eq!(probe.register(), QrtcStatus::Available);
        assert_eq!(
            probe.snapshot(),
            QrtcMetadataSnapshot {
                lifecycle: QrtcLifecycle::Active,
                same_thread: true,
                in_flight: 0,
                shutdown_was_idle: false,
            }
        );
    }

    #[test]
    fn metadata_probe_rejects_cross_thread_entries_and_shutdowns() {
        let probe = metadata_probe();
        assert_eq!(probe.register(), QrtcStatus::Available);
        let worker_probe = probe.clone();
        let (same_thread, entry, shutdown) = thread::spawn(move || {
            let snapshot = worker_probe.snapshot();
            (
                snapshot.same_thread,
                worker_probe.enter().err(),
                worker_probe.shutdown(),
            )
        })
        .join()
        .unwrap();
        assert!(!same_thread);
        assert_eq!(entry, Some(QrtcStatus::WrongThread));
        assert_eq!(shutdown, QrtcStatus::WrongThread);
        assert_eq!(probe.snapshot().lifecycle, QrtcLifecycle::Active);
    }

    #[test]
    fn metadata_probe_drains_bounded_entries_before_destruction() {
        let probe = metadata_probe();
        assert_eq!(probe.register(), QrtcStatus::Available);
        let entries: Vec<_> = (0..MAX_IN_FLIGHT_QRTC_ENTRIES)
            .map(|_| probe.enter().expect("same-thread entry"))
            .collect();
        assert_eq!(probe.enter().err(), Some(QrtcStatus::Unavailable));
        assert_eq!(probe.shutdown(), QrtcStatus::Closed);
        assert_eq!(
            probe.snapshot(),
            QrtcMetadataSnapshot {
                lifecycle: QrtcLifecycle::Closing,
                same_thread: true,
                in_flight: MAX_IN_FLIGHT_QRTC_ENTRIES,
                shutdown_was_idle: false,
            }
        );
        assert_eq!(probe.enter().err(), Some(QrtcStatus::Closed));
        drop(entries);
        assert_eq!(
            probe.snapshot(),
            QrtcMetadataSnapshot {
                lifecycle: QrtcLifecycle::Closing,
                same_thread: true,
                in_flight: 0,
                shutdown_was_idle: false,
            }
        );
        assert_eq!(probe.shutdown(), QrtcStatus::Closed);
        assert_eq!(probe.snapshot().lifecycle, QrtcLifecycle::Destroyed);
    }

    #[test]
    fn results_never_serialize_module_or_receiver_data() {
        let result = service(Arc::new(AtomicUsize::new(0))).request();
        assert_eq!(result.status, QrtcStatus::Available);
        assert_eq!(result.token.as_ref().map(String::len), Some(64));
    }
}
