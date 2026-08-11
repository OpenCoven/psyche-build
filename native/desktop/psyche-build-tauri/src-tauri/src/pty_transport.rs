use std::collections::VecDeque;
use std::error::Error;
use std::fmt;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;

pub const MAX_PENDING_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PENDING_FRAGMENTS: usize = 128;
pub const MAX_BATCH_BYTES: usize = 64 * 1024;
pub const MAX_IN_FLIGHT: usize = 2;
pub const VISIBLE_CADENCE: Duration = Duration::from_millis(16);
pub const HIDDEN_CADENCE: Duration = Duration::from_millis(100);
pub const EXIT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
pub const EXIT_TERMINATION_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
pub const MAX_RECENT_OUTPUT_SNAPSHOTS: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PumpLimits {
    pub max_pending_bytes: usize,
    pub max_pending_fragments: usize,
    pub max_batch_bytes: usize,
    pub max_in_flight: usize,
    pub visible_cadence: Duration,
    pub hidden_cadence: Duration,
    pub exit_drain_timeout: Duration,
}

impl Default for PumpLimits {
    fn default() -> Self {
        Self {
            max_pending_bytes: MAX_PENDING_BYTES,
            max_pending_fragments: MAX_PENDING_FRAGMENTS,
            max_batch_bytes: MAX_BATCH_BYTES,
            max_in_flight: MAX_IN_FLIGHT,
            visible_cadence: VISIBLE_CADENCE,
            hidden_cadence: HIDDEN_CADENCE,
            exit_drain_timeout: EXIT_DRAIN_TIMEOUT,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PumpLimitsError {
    Zero {
        field: &'static str,
    },
    ExceedsHardMaximum {
        field: &'static str,
        value: usize,
        maximum: usize,
    },
}

impl fmt::Display for PumpLimitsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Zero { field } => write!(formatter, "{field} must be greater than zero"),
            Self::ExceedsHardMaximum {
                field,
                value,
                maximum,
            } => write!(
                formatter,
                "{field} value {value} exceeds the hard maximum {maximum}"
            ),
        }
    }
}

impl Error for PumpLimitsError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapacityBudget {
    Bytes,
    Fragments,
    BytesAndFragments,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PushError {
    OversizedFragment {
        fragment: Vec<u8>,
        incoming_bytes: usize,
        max_pending_bytes: usize,
    },
    WouldBlock {
        fragment: Vec<u8>,
        budget: CapacityBudget,
        pending_bytes: usize,
        pending_fragments: usize,
        incoming_bytes: usize,
    },
}

impl fmt::Display for PushError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OversizedFragment {
                incoming_bytes,
                max_pending_bytes,
                ..
            } => write!(
                formatter,
                "PTY fragment contains {incoming_bytes} bytes and can never fit the \
                 {max_pending_bytes}-byte pending budget"
            ),
            Self::WouldBlock {
                budget,
                pending_bytes,
                pending_fragments,
                incoming_bytes,
                ..
            } => write!(
                formatter,
                "PTY queue would exceed {budget:?} budget \
                 ({pending_bytes} bytes, {pending_fragments} fragments, \
                 {incoming_bytes} incoming bytes)"
            ),
        }
    }
}

impl Error for PushError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaneVisibility {
    Visible,
    Hidden,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BatchReadiness {
    Empty,
    InFlightFull,
    WaitingForCadence { remaining: Duration },
    Ready,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedBatch {
    pub sequence: u64,
    pub data: Arc<[u8]>,
    pub enqueued_at_micros: u64,
    pub queued_bytes: usize,
    pub queue_depth: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PtyBatch {
    pub sequence: u64,
    pub data: Arc<[u8]>,
    pub emitted_at: Instant,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PrepareError {
    SequenceExhausted,
}

impl fmt::Display for PrepareError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SequenceExhausted => formatter.write_str("PTY batch sequence space exhausted"),
        }
    }
}

impl Error for PrepareError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommitError {
    NoPreparedBatch,
    SequenceMismatch { expected: u64, received: u64 },
    InFlightFull,
}

impl fmt::Display for CommitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoPreparedBatch => formatter.write_str("no PTY batch is prepared"),
            Self::SequenceMismatch { expected, received } => write!(
                formatter,
                "prepared PTY batch sequence is {expected}, not {received}"
            ),
            Self::InFlightFull => formatter.write_str("PTY in-flight batch window is full"),
        }
    }
}

impl Error for CommitError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AckOutcome {
    Advanced {
        sequence: u64,
        bytes: usize,
        emitted_at: Instant,
        acknowledged_at: Instant,
        latency: Duration,
    },
    Duplicate {
        sequence: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AckError {
    Unknown { received: u64 },
    Skipped { expected: u64, received: u64 },
    Future { highest_emitted: u64, received: u64 },
    ClockBeforeEmission { sequence: u64 },
}

impl fmt::Display for AckError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unknown { received } => {
                write!(formatter, "unknown PTY batch acknowledgement {received}")
            }
            Self::Skipped { expected, received } => write!(
                formatter,
                "PTY batch acknowledgement {received} skipped expected sequence {expected}"
            ),
            Self::Future {
                highest_emitted,
                received,
            } => write!(
                formatter,
                "PTY batch acknowledgement {received} is newer than emitted sequence \
                 {highest_emitted}"
            ),
            Self::ClockBeforeEmission { sequence } => write!(
                formatter,
                "acknowledgement time precedes emission for PTY batch {sequence}"
            ),
        }
    }
}

impl Error for AckError {}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PumpMetrics {
    pub bytes_accepted: u64,
    pub fragments_accepted: u64,
    pub bytes_emitted: u64,
    pub batches_emitted: u64,
    pub bytes_acknowledged: u64,
    pub batches_acknowledged: u64,
    pub push_would_block_count: u64,
    pub pending_bytes_high_water: usize,
    pub pending_fragments_high_water: usize,
    pub in_flight_batches_high_water: usize,
    pub in_flight_bytes_high_water: usize,
    pub total_ack_latency: Duration,
    pub max_ack_latency: Duration,
}

impl PumpMetrics {
    pub fn average_batch_bytes(&self) -> Option<f64> {
        (self.batches_emitted != 0).then(|| self.bytes_emitted as f64 / self.batches_emitted as f64)
    }

    pub fn average_ack_latency(&self) -> Option<Duration> {
        if self.batches_acknowledged == 0 {
            return None;
        }

        let average_nanos =
            self.total_ack_latency.as_nanos() / u128::from(self.batches_acknowledged);
        let seconds = average_nanos / 1_000_000_000;
        if seconds > u128::from(u64::MAX) {
            return Some(Duration::MAX);
        }

        Some(Duration::new(
            seconds as u64,
            (average_nanos % 1_000_000_000) as u32,
        ))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PendingFragmentProgress {
    pub consumed_bytes: usize,
    pub remaining_bytes: usize,
    pub total_bytes: usize,
}

#[derive(Debug)]
struct PendingFragment {
    data: Vec<u8>,
    consumed_bytes: usize,
    enqueued_at_micros: u64,
}

impl PendingFragment {
    fn new(data: Vec<u8>, enqueued_at_micros: u64) -> Self {
        Self {
            data,
            consumed_bytes: 0,
            enqueued_at_micros,
        }
    }

    fn remaining(&self) -> &[u8] {
        &self.data[self.consumed_bytes..]
    }

    fn progress(&self) -> PendingFragmentProgress {
        PendingFragmentProgress {
            consumed_bytes: self.consumed_bytes,
            remaining_bytes: self.data.len() - self.consumed_bytes,
            total_bytes: self.data.len(),
        }
    }
}

#[derive(Debug)]
struct PreparedEmission {
    batch: PreparedBatch,
    completed_fragments: usize,
}

#[derive(Debug)]
pub struct PumpState {
    limits: PumpLimits,
    pending: VecDeque<PendingFragment>,
    queued_bytes: usize,
    pending_bytes: usize,
    pending_fragments: usize,
    prepared: Option<PreparedEmission>,
    in_flight: VecDeque<PtyBatch>,
    in_flight_bytes: usize,
    last_emitted_at: Option<Instant>,
    last_emitted_sequence: u64,
    last_acked_sequence: u64,
    metrics: PumpMetrics,
}

impl Default for PumpState {
    fn default() -> Self {
        Self::new(PumpLimits::default()).expect("default PTY pump limits must be valid")
    }
}

impl PumpState {
    pub fn new(limits: PumpLimits) -> Result<Self, PumpLimitsError> {
        validate_limit(
            "max_pending_bytes",
            limits.max_pending_bytes,
            MAX_PENDING_BYTES,
        )?;
        validate_limit(
            "max_pending_fragments",
            limits.max_pending_fragments,
            MAX_PENDING_FRAGMENTS,
        )?;
        validate_limit("max_batch_bytes", limits.max_batch_bytes, MAX_BATCH_BYTES)?;
        validate_limit("max_in_flight", limits.max_in_flight, MAX_IN_FLIGHT)?;

        Ok(Self {
            limits,
            pending: VecDeque::new(),
            queued_bytes: 0,
            pending_bytes: 0,
            pending_fragments: 0,
            prepared: None,
            in_flight: VecDeque::new(),
            in_flight_bytes: 0,
            last_emitted_at: None,
            last_emitted_sequence: 0,
            last_acked_sequence: 0,
            metrics: PumpMetrics::default(),
        })
    }

    pub fn limits(&self) -> &PumpLimits {
        &self.limits
    }

    pub fn metrics(&self) -> &PumpMetrics {
        &self.metrics
    }

    pub fn pending_bytes(&self) -> usize {
        self.pending_bytes
    }

    pub fn pending_fragments(&self) -> usize {
        self.pending_fragments
    }

    pub fn queued_bytes(&self) -> usize {
        self.queued_bytes
    }

    pub fn queue_depth(&self) -> usize {
        self.pending.len()
    }

    pub fn has_prepared(&self) -> bool {
        self.prepared.is_some()
    }

    pub fn is_empty(&self) -> bool {
        self.pending_bytes == 0 && self.prepared.is_none() && self.in_flight.is_empty()
    }

    pub fn oldest_queued_fragment_progress(&self) -> Option<PendingFragmentProgress> {
        self.pending.front().map(PendingFragment::progress)
    }

    pub fn in_flight_len(&self) -> usize {
        self.in_flight.len()
    }

    pub fn in_flight_bytes(&self) -> usize {
        self.in_flight_bytes
    }

    pub fn last_acked_sequence(&self) -> u64 {
        self.last_acked_sequence
    }

    pub fn last_emitted_at(&self) -> Option<Instant> {
        self.last_emitted_at
    }

    pub fn push(&mut self, fragment: Vec<u8>) -> Result<(), PushError> {
        self.push_at(fragment, 0)
    }

    fn push_at(&mut self, fragment: Vec<u8>, enqueued_at_micros: u64) -> Result<(), PushError> {
        if fragment.is_empty() {
            return Ok(());
        }

        let incoming_bytes = fragment.len();
        if incoming_bytes > self.limits.max_pending_bytes {
            return Err(PushError::OversizedFragment {
                fragment,
                incoming_bytes,
                max_pending_bytes: self.limits.max_pending_bytes,
            });
        }

        let next_bytes = self.pending_bytes.checked_add(fragment.len());
        let exceeds_bytes = next_bytes
            .map(|bytes| bytes > self.limits.max_pending_bytes)
            .unwrap_or(true);
        let exceeds_fragments = self.pending_fragments >= self.limits.max_pending_fragments;

        if exceeds_bytes || exceeds_fragments {
            self.metrics.push_would_block_count =
                self.metrics.push_would_block_count.saturating_add(1);
            let budget = match (exceeds_bytes, exceeds_fragments) {
                (true, true) => CapacityBudget::BytesAndFragments,
                (true, false) => CapacityBudget::Bytes,
                (false, true) => CapacityBudget::Fragments,
                (false, false) => unreachable!("a budget must be exceeded"),
            };
            return Err(PushError::WouldBlock {
                fragment,
                budget,
                pending_bytes: self.pending_bytes,
                pending_fragments: self.pending_fragments,
                incoming_bytes,
            });
        }

        let fragment_bytes = fragment.len();
        self.pending
            .push_back(PendingFragment::new(fragment, enqueued_at_micros));
        self.queued_bytes += fragment_bytes;
        self.pending_bytes = next_bytes.expect("checked above");
        self.pending_fragments += 1;
        self.metrics.bytes_accepted = self
            .metrics
            .bytes_accepted
            .saturating_add(fragment_bytes as u64);
        self.metrics.fragments_accepted = self.metrics.fragments_accepted.saturating_add(1);
        self.metrics.pending_bytes_high_water = self
            .metrics
            .pending_bytes_high_water
            .max(self.pending_bytes);
        self.metrics.pending_fragments_high_water = self
            .metrics
            .pending_fragments_high_water
            .max(self.pending_fragments);

        Ok(())
    }

    pub fn readiness(&self, now: Instant, visibility: PaneVisibility) -> BatchReadiness {
        if self.prepared.is_some() {
            return BatchReadiness::Ready;
        }
        if self.queued_bytes == 0 {
            return BatchReadiness::Empty;
        }
        if self.in_flight.len() >= self.limits.max_in_flight {
            return BatchReadiness::InFlightFull;
        }

        let Some(last_emitted_at) = self.last_emitted_at else {
            return BatchReadiness::Ready;
        };
        let cadence = match visibility {
            PaneVisibility::Visible => self.limits.visible_cadence,
            PaneVisibility::Hidden => self.limits.hidden_cadence,
        };
        let elapsed = now
            .checked_duration_since(last_emitted_at)
            .unwrap_or(Duration::ZERO);
        if elapsed < cadence {
            return BatchReadiness::WaitingForCadence {
                remaining: cadence - elapsed,
            };
        }

        BatchReadiness::Ready
    }

    /// Repeated calls return the same prepared batch until it is committed.
    ///
    /// Preparation advances fragment cursors but does not advance cadence,
    /// sequence state, in-flight occupancy, or emission metrics.
    pub fn prepare_batch(
        &mut self,
        now: Instant,
        visibility: PaneVisibility,
    ) -> Result<Option<PreparedBatch>, PrepareError> {
        if let Some(prepared) = &self.prepared {
            return Ok(Some(prepared.batch.clone()));
        }
        if self.readiness(now, visibility) != BatchReadiness::Ready {
            return Ok(None);
        }

        let sequence = self
            .last_emitted_sequence
            .checked_add(1)
            .ok_or(PrepareError::SequenceExhausted)?;
        let enqueued_at_micros = self
            .pending
            .front()
            .expect("queued byte accounting guarantees a fragment")
            .enqueued_at_micros;
        let batch_bytes = self.queued_bytes.min(self.limits.max_batch_bytes);
        let mut data = Vec::with_capacity(batch_bytes);
        let mut completed_fragments = 0;

        while data.len() < batch_bytes {
            let fragment_completed = {
                let fragment = self
                    .pending
                    .front_mut()
                    .expect("pending byte accounting guarantees a fragment");
                let remaining = batch_bytes - data.len();
                let copied_bytes = fragment.remaining().len().min(remaining);
                data.extend_from_slice(&fragment.remaining()[..copied_bytes]);
                fragment.consumed_bytes += copied_bytes;
                self.queued_bytes -= copied_bytes;
                fragment.remaining().is_empty()
            };
            if fragment_completed {
                self.pending.pop_front();
                completed_fragments += 1;
            }
        }

        let prepared = PreparedBatch {
            sequence,
            data: data.into(),
            enqueued_at_micros,
            queued_bytes: self.queued_bytes,
            queue_depth: self.pending.len(),
        };
        self.prepared = Some(PreparedEmission {
            batch: prepared.clone(),
            completed_fragments,
        });

        Ok(Some(prepared))
    }

    /// Records a successfully delivered prepared batch as emitted and in flight.
    pub fn commit_prepared(
        &mut self,
        sequence: u64,
        emitted_at: Instant,
    ) -> Result<PtyBatch, CommitError> {
        let prepared = self.prepared.as_ref().ok_or(CommitError::NoPreparedBatch)?;
        if sequence != prepared.batch.sequence {
            return Err(CommitError::SequenceMismatch {
                expected: prepared.batch.sequence,
                received: sequence,
            });
        }
        if self.in_flight.len() >= self.limits.max_in_flight {
            return Err(CommitError::InFlightFull);
        }

        let prepared = self
            .prepared
            .take()
            .expect("prepared batch was validated above");
        let batch = PtyBatch {
            sequence: prepared.batch.sequence,
            data: prepared.batch.data,
            emitted_at,
        };

        self.pending_bytes -= batch.data.len();
        self.pending_fragments -= prepared.completed_fragments;
        self.in_flight_bytes += batch.data.len();
        self.in_flight.push_back(batch.clone());
        self.last_emitted_at = Some(emitted_at);
        self.last_emitted_sequence = batch.sequence;
        self.metrics.bytes_emitted = self
            .metrics
            .bytes_emitted
            .saturating_add(batch.data.len() as u64);
        self.metrics.batches_emitted = self.metrics.batches_emitted.saturating_add(1);
        self.metrics.in_flight_batches_high_water = self
            .metrics
            .in_flight_batches_high_water
            .max(self.in_flight.len());
        self.metrics.in_flight_bytes_high_water = self
            .metrics
            .in_flight_bytes_high_water
            .max(self.in_flight_bytes);

        Ok(batch)
    }

    pub fn acknowledge(
        &mut self,
        sequence: u64,
        acknowledged_at: Instant,
    ) -> Result<AckOutcome, AckError> {
        if sequence == 0 {
            return Err(AckError::Unknown { received: sequence });
        }
        if sequence <= self.last_acked_sequence {
            return Ok(AckOutcome::Duplicate { sequence });
        }
        if sequence > self.last_emitted_sequence {
            return Err(AckError::Future {
                highest_emitted: self.last_emitted_sequence,
                received: sequence,
            });
        }

        let expected = self
            .in_flight
            .front()
            .map(|batch| batch.sequence)
            .ok_or(AckError::Unknown { received: sequence })?;
        if sequence != expected {
            return Err(AckError::Skipped {
                expected,
                received: sequence,
            });
        }

        let batch = self
            .in_flight
            .front()
            .expect("expected sequence came from the front");
        let latency = acknowledged_at
            .checked_duration_since(batch.emitted_at)
            .ok_or(AckError::ClockBeforeEmission {
                sequence: batch.sequence,
            })?;
        let batch = self
            .in_flight
            .pop_front()
            .expect("validated acknowledgement must have an in-flight batch");

        self.in_flight_bytes -= batch.data.len();
        self.last_acked_sequence = sequence;
        self.metrics.bytes_acknowledged = self
            .metrics
            .bytes_acknowledged
            .saturating_add(batch.data.len() as u64);
        self.metrics.batches_acknowledged = self.metrics.batches_acknowledged.saturating_add(1);
        self.metrics.total_ack_latency = self
            .metrics
            .total_ack_latency
            .checked_add(latency)
            .unwrap_or(Duration::MAX);
        self.metrics.max_ack_latency = self.metrics.max_ack_latency.max(latency);

        Ok(AckOutcome::Advanced {
            sequence,
            bytes: batch.data.len(),
            emitted_at: batch.emitted_at,
            acknowledged_at,
            latency,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyDataBatchEvent {
    pub thread_id: String,
    pub sequence: u64,
    pub bytes: Vec<u8>,
    pub byte_count: usize,
    pub enqueued_at_micros: u64,
    pub emitted_at_micros: u64,
    pub queued_bytes: usize,
    pub queue_depth: usize,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ClockSample {
    pub instant: Instant,
    pub micros: u64,
}

pub(crate) trait PumpClock: Send + Sync {
    fn sample(&self) -> ClockSample;
}

#[derive(Debug)]
struct SystemPumpClock {
    origin: Instant,
}

impl SystemPumpClock {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl PumpClock for SystemPumpClock {
    fn sample(&self) -> ClockSample {
        let instant = Instant::now();
        ClockSample {
            instant,
            micros: duration_micros(
                instant
                    .checked_duration_since(self.origin)
                    .unwrap_or(Duration::ZERO),
            ),
        }
    }
}

fn duration_micros(duration: Duration) -> u64 {
    duration.as_micros().min(u128::from(u64::MAX)) as u64
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EnqueueError {
    OversizedFragment {
        fragment: Vec<u8>,
        incoming_bytes: usize,
        max_pending_bytes: usize,
    },
    Cancelled {
        fragment: Vec<u8>,
    },
}

impl fmt::Display for EnqueueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OversizedFragment {
                incoming_bytes,
                max_pending_bytes,
                ..
            } => write!(
                formatter,
                "PTY fragment contains {incoming_bytes} bytes and can never fit the \
                 {max_pending_bytes}-byte pending budget"
            ),
            Self::Cancelled { .. } => formatter.write_str("PTY output pump is cancelled"),
        }
    }
}

impl Error for EnqueueError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutputPumpError {
    Prepare(PrepareError),
    Commit(CommitError),
}

impl fmt::Display for OutputPumpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Prepare(error) => error.fmt(formatter),
            Self::Commit(error) => error.fmt(formatter),
        }
    }
}

impl Error for OutputPumpError {}

impl From<PrepareError> for OutputPumpError {
    fn from(error: PrepareError) -> Self {
        Self::Prepare(error)
    }
}

impl From<CommitError> for OutputPumpError {
    fn from(error: CommitError) -> Self {
        Self::Commit(error)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EmitOutcome {
    Emitted { sequence: u64 },
    Failed { sequence: u64, error: String },
    NotReady(BatchReadiness),
    Busy,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrainOutcome {
    Drained,
    TimedOut,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CompletionOutcome {
    Completed,
    TimedOut,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitShutdownOutcome {
    Drained,
    TimedOut,
    Cancelled,
}

pub(crate) trait ExitShutdownHooks {
    fn now(&self) -> Instant;
    fn request_drain(&mut self);
    fn wait_for_reader(&mut self, timeout: Duration) -> CompletionOutcome;
    fn join_reader(&mut self);
    fn wait_for_drain(&mut self, timeout: Duration) -> DrainOutcome;
    fn cancel_pump(&mut self);
    fn wait_for_worker(&mut self, timeout: Duration) -> CompletionOutcome;
    fn join_worker(&mut self);
    fn record_drain_timeout(&mut self);
    fn terminate_process(&mut self);
    fn remove_session(&mut self);
    fn finish_terminated_cleanup(&mut self, timeout: Duration);
}

pub(crate) fn coordinate_exit_shutdown<H: ExitShutdownHooks>(
    hooks: &mut H,
    timeout: Duration,
) -> ExitShutdownOutcome {
    let started_at = hooks.now();
    let deadline = started_at.checked_add(timeout).unwrap_or(started_at);
    hooks.request_drain();

    if hooks.wait_for_reader(remaining_until(hooks.now(), deadline)) == CompletionOutcome::TimedOut
    {
        return timeout_exit_shutdown(hooks);
    }
    hooks.join_reader();

    match hooks.wait_for_drain(remaining_until(hooks.now(), deadline)) {
        DrainOutcome::Drained => {}
        DrainOutcome::TimedOut => return timeout_exit_shutdown(hooks),
        DrainOutcome::Cancelled => return cancel_exit_shutdown(hooks, deadline),
    }

    hooks.cancel_pump();
    if hooks.wait_for_worker(remaining_until(hooks.now(), deadline)) == CompletionOutcome::TimedOut
    {
        return timeout_exit_shutdown(hooks);
    }
    hooks.join_worker();
    hooks.remove_session();
    ExitShutdownOutcome::Drained
}

fn remaining_until(now: Instant, deadline: Instant) -> Duration {
    deadline
        .checked_duration_since(now)
        .unwrap_or(Duration::ZERO)
}

fn timeout_exit_shutdown<H: ExitShutdownHooks>(hooks: &mut H) -> ExitShutdownOutcome {
    hooks.record_drain_timeout();
    hooks.terminate_process();
    hooks.cancel_pump();
    hooks.remove_session();
    hooks.finish_terminated_cleanup(EXIT_TERMINATION_CLEANUP_TIMEOUT);
    ExitShutdownOutcome::TimedOut
}

fn cancel_exit_shutdown<H: ExitShutdownHooks>(
    hooks: &mut H,
    deadline: Instant,
) -> ExitShutdownOutcome {
    hooks.cancel_pump();
    if hooks.wait_for_worker(remaining_until(hooks.now(), deadline)) == CompletionOutcome::TimedOut
    {
        return timeout_exit_shutdown(hooks);
    }
    hooks.join_worker();
    hooks.remove_session();
    ExitShutdownOutcome::Cancelled
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct RuntimePumpMetrics {
    blocked_reader_count: u64,
    total_blocked_reader_duration: Duration,
    max_blocked_reader_duration: Duration,
    emit_failure_count: u64,
    emit_retry_count: u64,
    visibility_transition_count: u64,
    drain_timeout_count: u64,
    worker_error_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputPumpMetrics {
    pub state: PumpMetrics,
    pub blocked_reader_count: u64,
    pub total_blocked_reader_duration: Duration,
    pub max_blocked_reader_duration: Duration,
    pub emit_failure_count: u64,
    pub emit_retry_count: u64,
    pub visibility_transition_count: u64,
    pub drain_timeout_count: u64,
    pub worker_error_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputPumpSnapshot {
    pub thread_id: String,
    pub pending_bytes: usize,
    pub pending_fragments: usize,
    pub queued_bytes: usize,
    pub queue_depth: usize,
    pub prepared: bool,
    pub in_flight_batches: usize,
    pub in_flight_bytes: usize,
    pub last_acked_sequence: u64,
    pub blocked_producers: usize,
    pub visibility: PaneVisibility,
    pub effective_cadence: Duration,
    pub draining: bool,
    pub cancelled: bool,
    pub worker_running: bool,
    pub metrics: OutputPumpMetrics,
}

impl OutputPumpSnapshot {
    pub fn is_empty(&self) -> bool {
        self.pending_bytes == 0 && !self.prepared && self.in_flight_batches == 0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TransportSessionKey {
    pub thread_id: String,
    pub generation: u64,
}

impl TransportSessionKey {
    pub fn new(thread_id: impl Into<String>, generation: u64) -> Self {
        Self {
            thread_id: thread_id.into(),
            generation,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinalOutputPumpSnapshot {
    pub key: TransportSessionKey,
    pub outcome: ExitShutdownOutcome,
    pub transport: OutputPumpSnapshot,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecentSnapshotStoreError {
    ZeroCapacity,
    CapacityExceedsMaximum { requested: usize, maximum: usize },
}

impl fmt::Display for RecentSnapshotStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroCapacity => formatter.write_str("recent snapshot capacity must be non-zero"),
            Self::CapacityExceedsMaximum { requested, maximum } => write!(
                formatter,
                "recent snapshot capacity {requested} exceeds maximum {maximum}"
            ),
        }
    }
}

impl Error for RecentSnapshotStoreError {}

#[derive(Debug)]
pub struct RecentOutputSnapshots {
    capacity: usize,
    entries: VecDeque<FinalOutputPumpSnapshot>,
}

impl Default for RecentOutputSnapshots {
    fn default() -> Self {
        Self::new(MAX_RECENT_OUTPUT_SNAPSHOTS)
            .expect("default recent PTY snapshot capacity must be valid")
    }
}

impl RecentOutputSnapshots {
    pub fn new(capacity: usize) -> Result<Self, RecentSnapshotStoreError> {
        if capacity == 0 {
            return Err(RecentSnapshotStoreError::ZeroCapacity);
        }
        if capacity > MAX_RECENT_OUTPUT_SNAPSHOTS {
            return Err(RecentSnapshotStoreError::CapacityExceedsMaximum {
                requested: capacity,
                maximum: MAX_RECENT_OUTPUT_SNAPSHOTS,
            });
        }
        Ok(Self {
            capacity,
            entries: VecDeque::with_capacity(capacity),
        })
    }

    pub fn insert(&mut self, snapshot: FinalOutputPumpSnapshot) {
        if let Some(position) = self
            .entries
            .iter()
            .position(|existing| existing.key == snapshot.key)
        {
            self.entries.remove(position);
        }
        while self.entries.len() >= self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back(snapshot);
    }

    pub fn get(&self, key: &TransportSessionKey) -> Option<&FinalOutputPumpSnapshot> {
        self.entries.iter().find(|snapshot| &snapshot.key == key)
    }

    pub fn latest_for_thread(&self, thread_id: &str) -> Option<&FinalOutputPumpSnapshot> {
        self.entries
            .iter()
            .rev()
            .find(|snapshot| snapshot.key.thread_id == thread_id)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[derive(Debug)]
struct CachedPreparedEvent {
    prepared: PreparedBatch,
    failed_attempts: u64,
    last_attempt_at: Option<Instant>,
}

#[derive(Debug)]
struct SynchronizedPumpState {
    state: PumpState,
    prepared_event: Option<CachedPreparedEvent>,
    visibility: PaneVisibility,
    blocked_producers: usize,
    draining: bool,
    cancelled: bool,
    worker_running: bool,
    emit_in_progress: bool,
    metrics: RuntimePumpMetrics,
}

struct OutputPumpShared {
    thread_id: String,
    clock: Arc<dyn PumpClock>,
    state: Mutex<SynchronizedPumpState>,
    wake: Condvar,
    worker: Mutex<Option<JoinHandle<()>>>,
}

struct WorkerRunningGuard {
    shared: Weak<OutputPumpShared>,
}

impl Drop for WorkerRunningGuard {
    fn drop(&mut self) {
        let Some(shared) = self.shared.upgrade() else {
            return;
        };
        lock_unpoisoned(&shared.state).worker_running = false;
        shared.wake.notify_all();
    }
}

#[derive(Clone)]
pub struct OutputPump {
    shared: Arc<OutputPumpShared>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkerStartError {
    AlreadyStarted,
    Cancelled,
    Spawn(String),
}

impl fmt::Display for WorkerStartError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyStarted => formatter.write_str("PTY output pump worker already started"),
            Self::Cancelled => formatter.write_str("PTY output pump is cancelled"),
            Self::Spawn(error) => write!(formatter, "failed to start PTY output pump: {error}"),
        }
    }
}

impl Error for WorkerStartError {}

impl OutputPump {
    pub fn new(thread_id: String) -> Result<Self, PumpLimitsError> {
        Self::new_with_clock(
            thread_id,
            PumpLimits::default(),
            Arc::new(SystemPumpClock::new()),
        )
    }

    pub(crate) fn new_with_clock(
        thread_id: String,
        limits: PumpLimits,
        clock: Arc<dyn PumpClock>,
    ) -> Result<Self, PumpLimitsError> {
        Ok(Self {
            shared: Arc::new(OutputPumpShared {
                thread_id,
                clock,
                state: Mutex::new(SynchronizedPumpState {
                    state: PumpState::new(limits)?,
                    prepared_event: None,
                    visibility: PaneVisibility::Visible,
                    blocked_producers: 0,
                    draining: false,
                    cancelled: false,
                    worker_running: false,
                    emit_in_progress: false,
                    metrics: RuntimePumpMetrics::default(),
                }),
                wake: Condvar::new(),
                worker: Mutex::new(None),
            }),
        })
    }

    pub fn enqueue(&self, fragment: Vec<u8>) -> Result<(), EnqueueError> {
        let enqueued_at = self.shared.clock.sample();
        let mut fragment = fragment;
        let mut blocked_at = None;
        let mut guard = lock_unpoisoned(&self.shared.state);

        loop {
            if guard.cancelled {
                finish_blocked_enqueue(&mut guard, blocked_at, self.shared.clock.sample().instant);
                return Err(EnqueueError::Cancelled { fragment });
            }

            match guard.state.push_at(fragment, enqueued_at.micros) {
                Ok(()) => {
                    finish_blocked_enqueue(
                        &mut guard,
                        blocked_at,
                        self.shared.clock.sample().instant,
                    );
                    drop(guard);
                    self.shared.wake.notify_all();
                    return Ok(());
                }
                Err(PushError::OversizedFragment {
                    fragment,
                    incoming_bytes,
                    max_pending_bytes,
                }) => {
                    finish_blocked_enqueue(
                        &mut guard,
                        blocked_at,
                        self.shared.clock.sample().instant,
                    );
                    return Err(EnqueueError::OversizedFragment {
                        fragment,
                        incoming_bytes,
                        max_pending_bytes,
                    });
                }
                Err(PushError::WouldBlock {
                    fragment: returned, ..
                }) => {
                    fragment = returned;
                    if blocked_at.is_none() {
                        blocked_at = Some(self.shared.clock.sample().instant);
                        guard.blocked_producers = guard.blocked_producers.saturating_add(1);
                    }
                    guard = wait_unpoisoned(&self.shared.wake, guard);
                }
            }
        }
    }

    pub fn emit_ready<E>(&self, mut emitter: E) -> Result<EmitOutcome, OutputPumpError>
    where
        E: FnMut(&PtyDataBatchEvent) -> Result<(), String>,
    {
        emit_ready_shared(&self.shared, &mut emitter)
    }

    pub fn start_worker<E>(&self, emitter: E) -> Result<(), WorkerStartError>
    where
        E: FnMut(&PtyDataBatchEvent) -> Result<(), String> + Send + 'static,
    {
        let mut worker = lock_unpoisoned(&self.shared.worker);
        if worker.is_some() {
            return Err(WorkerStartError::AlreadyStarted);
        }
        {
            let mut state = lock_unpoisoned(&self.shared.state);
            if state.cancelled {
                return Err(WorkerStartError::Cancelled);
            }
            if state.worker_running {
                return Err(WorkerStartError::AlreadyStarted);
            }
            state.worker_running = true;
        }

        let weak = Arc::downgrade(&self.shared);
        match thread::Builder::new()
            .name("pty-output-pump".to_string())
            .spawn(move || output_worker(weak, emitter))
        {
            Ok(handle) => {
                *worker = Some(handle);
                Ok(())
            }
            Err(error) => {
                lock_unpoisoned(&self.shared.state).worker_running = false;
                self.shared.wake.notify_all();
                Err(WorkerStartError::Spawn(error.to_string()))
            }
        }
    }

    pub fn acknowledge(&self, sequence: u64) -> Result<AckOutcome, AckError> {
        let acknowledged_at = self.shared.clock.sample().instant;
        let mut guard = lock_unpoisoned(&self.shared.state);
        let outcome = guard.state.acknowledge(sequence, acknowledged_at)?;
        let advanced = matches!(outcome, AckOutcome::Advanced { .. });
        drop(guard);
        if advanced {
            self.shared.wake.notify_all();
        }
        Ok(outcome)
    }

    pub fn set_visibility(&self, visibility: PaneVisibility) -> bool {
        let mut guard = lock_unpoisoned(&self.shared.state);
        if guard.visibility == visibility {
            return false;
        }
        guard.visibility = visibility;
        guard.metrics.visibility_transition_count =
            guard.metrics.visibility_transition_count.saturating_add(1);
        drop(guard);
        self.shared.wake.notify_all();
        true
    }

    pub fn request_drain(&self) {
        let mut guard = lock_unpoisoned(&self.shared.state);
        guard.draining = true;
        drop(guard);
        self.shared.wake.notify_all();
    }

    pub fn wait_for_drain(&self) -> DrainOutcome {
        let timeout = lock_unpoisoned(&self.shared.state)
            .state
            .limits()
            .exit_drain_timeout;
        self.wait_for_drain_timeout(timeout)
    }

    pub fn wait_for_drain_timeout(&self, timeout: Duration) -> DrainOutcome {
        let outcome = self.wait_for_drain_timeout_unrecorded(timeout);
        if outcome == DrainOutcome::TimedOut {
            self.record_drain_timeout();
        }
        outcome
    }

    pub(crate) fn wait_for_drain_timeout_unrecorded(&self, timeout: Duration) -> DrainOutcome {
        let started_at = Instant::now();
        let mut guard = lock_unpoisoned(&self.shared.state);

        loop {
            if guard.cancelled {
                return DrainOutcome::Cancelled;
            }
            if guard.state.is_empty() {
                return DrainOutcome::Drained;
            }

            let elapsed = started_at.elapsed();
            if elapsed >= timeout {
                return DrainOutcome::TimedOut;
            }
            guard = wait_timeout_unpoisoned(&self.shared.wake, guard, timeout - elapsed);
        }
    }

    pub(crate) fn record_drain_timeout(&self) {
        let mut guard = lock_unpoisoned(&self.shared.state);
        guard.metrics.drain_timeout_count = guard.metrics.drain_timeout_count.saturating_add(1);
    }

    pub fn cancel(&self) -> bool {
        let mut guard = lock_unpoisoned(&self.shared.state);
        if guard.cancelled {
            return false;
        }
        guard.cancelled = true;
        drop(guard);
        self.shared.wake.notify_all();
        true
    }

    pub fn cancel_and_join(&self) -> thread::Result<()> {
        self.cancel();
        let worker = lock_unpoisoned(&self.shared.worker).take();
        let result = match worker {
            Some(worker) => worker.join(),
            None => Ok(()),
        };
        if result.is_ok() {
            let mut state = lock_unpoisoned(&self.shared.state);
            while state.worker_running {
                state = wait_unpoisoned(&self.shared.wake, state);
            }
        }
        result
    }

    pub(crate) fn wait_for_worker_timeout(&self, timeout: Duration) -> CompletionOutcome {
        let started_at = Instant::now();
        let mut guard = lock_unpoisoned(&self.shared.state);
        loop {
            if !guard.worker_running {
                return CompletionOutcome::Completed;
            }
            let elapsed = started_at.elapsed();
            if elapsed >= timeout {
                return CompletionOutcome::TimedOut;
            }
            guard = wait_timeout_unpoisoned(&self.shared.wake, guard, timeout - elapsed);
        }
    }

    pub(crate) fn join_worker_after_completion(&self) -> thread::Result<()> {
        let worker = lock_unpoisoned(&self.shared.worker).take();
        match worker {
            Some(worker) => worker.join(),
            None => Ok(()),
        }
    }

    pub fn snapshot(&self) -> OutputPumpSnapshot {
        let guard = lock_unpoisoned(&self.shared.state);
        let runtime_metrics = &guard.metrics;
        OutputPumpSnapshot {
            thread_id: self.shared.thread_id.clone(),
            pending_bytes: guard.state.pending_bytes(),
            pending_fragments: guard.state.pending_fragments(),
            queued_bytes: guard.state.queued_bytes(),
            queue_depth: guard.state.queue_depth(),
            prepared: guard.state.has_prepared(),
            in_flight_batches: guard.state.in_flight_len(),
            in_flight_bytes: guard.state.in_flight_bytes(),
            last_acked_sequence: guard.state.last_acked_sequence(),
            blocked_producers: guard.blocked_producers,
            visibility: guard.visibility,
            effective_cadence: effective_cadence(&guard),
            draining: guard.draining,
            cancelled: guard.cancelled,
            worker_running: guard.worker_running,
            metrics: OutputPumpMetrics {
                state: guard.state.metrics().clone(),
                blocked_reader_count: runtime_metrics.blocked_reader_count,
                total_blocked_reader_duration: runtime_metrics.total_blocked_reader_duration,
                max_blocked_reader_duration: runtime_metrics.max_blocked_reader_duration,
                emit_failure_count: runtime_metrics.emit_failure_count,
                emit_retry_count: runtime_metrics.emit_retry_count,
                visibility_transition_count: runtime_metrics.visibility_transition_count,
                drain_timeout_count: runtime_metrics.drain_timeout_count,
                worker_error_count: runtime_metrics.worker_error_count,
            },
        }
    }

    pub fn ptr_eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.shared, &other.shared)
    }
}

impl Drop for OutputPump {
    fn drop(&mut self) {
        let strong_count = Arc::strong_count(&self.shared);
        let worker_running = lock_unpoisoned(&self.shared.state).worker_running;
        let last_external_handle = if worker_running {
            strong_count <= 2
        } else {
            strong_count == 1
        };
        if last_external_handle {
            self.cancel();
        }
    }
}

fn finish_blocked_enqueue(
    state: &mut SynchronizedPumpState,
    blocked_at: Option<Instant>,
    finished_at: Instant,
) {
    let Some(blocked_at) = blocked_at else {
        return;
    };
    state.blocked_producers = state.blocked_producers.saturating_sub(1);
    let duration = finished_at
        .checked_duration_since(blocked_at)
        .unwrap_or(Duration::ZERO);
    state.metrics.blocked_reader_count = state.metrics.blocked_reader_count.saturating_add(1);
    state.metrics.total_blocked_reader_duration = state
        .metrics
        .total_blocked_reader_duration
        .checked_add(duration)
        .unwrap_or(Duration::MAX);
    state.metrics.max_blocked_reader_duration =
        state.metrics.max_blocked_reader_duration.max(duration);
}

fn effective_cadence(state: &SynchronizedPumpState) -> Duration {
    match state.visibility {
        PaneVisibility::Visible => state.state.limits().visible_cadence,
        PaneVisibility::Hidden => state.state.limits().hidden_cadence,
    }
}

fn synchronized_readiness(state: &SynchronizedPumpState, now: Instant) -> BatchReadiness {
    if let Some(prepared) = &state.prepared_event {
        if prepared.failed_attempts != 0 {
            if let Some(last_attempt_at) = prepared.last_attempt_at {
                let cadence = effective_cadence(state);
                let elapsed = now
                    .checked_duration_since(last_attempt_at)
                    .unwrap_or(Duration::ZERO);
                if elapsed < cadence {
                    return BatchReadiness::WaitingForCadence {
                        remaining: cadence - elapsed,
                    };
                }
            }
        }
    }
    state.state.readiness(now, state.visibility)
}

fn emit_ready_shared<E>(
    shared: &Arc<OutputPumpShared>,
    emitter: &mut E,
) -> Result<EmitOutcome, OutputPumpError>
where
    E: FnMut(&PtyDataBatchEvent) -> Result<(), String>,
{
    let sample = shared.clock.sample();
    let (event, sequence) = {
        let mut guard = lock_unpoisoned(&shared.state);
        if guard.cancelled {
            return Ok(EmitOutcome::Cancelled);
        }
        if guard.emit_in_progress {
            return Ok(EmitOutcome::Busy);
        }
        let readiness = synchronized_readiness(&guard, sample.instant);
        if readiness != BatchReadiness::Ready {
            return Ok(EmitOutcome::NotReady(readiness));
        }

        let visibility = guard.visibility;
        let prepared = guard
            .state
            .prepare_batch(sample.instant, visibility)?
            .expect("ready PTY pump must prepare a batch");
        if guard.prepared_event.is_none() {
            guard.prepared_event = Some(CachedPreparedEvent {
                prepared,
                failed_attempts: 0,
                last_attempt_at: None,
            });
        }

        let is_retry = guard
            .prepared_event
            .as_ref()
            .is_some_and(|prepared| prepared.failed_attempts != 0);
        if is_retry {
            guard.metrics.emit_retry_count = guard.metrics.emit_retry_count.saturating_add(1);
        }
        let prepared_event = guard
            .prepared_event
            .as_mut()
            .expect("prepared state must have a cached event");
        prepared_event.last_attempt_at = Some(sample.instant);
        let prepared = prepared_event.prepared.clone();
        let sequence = prepared.sequence;
        guard.emit_in_progress = true;
        (
            PtyDataBatchEvent {
                thread_id: shared.thread_id.clone(),
                sequence,
                bytes: prepared.data.as_ref().to_vec(),
                byte_count: prepared.data.len(),
                enqueued_at_micros: prepared.enqueued_at_micros,
                emitted_at_micros: sample.micros,
                queued_bytes: prepared.queued_bytes,
                queue_depth: prepared.queue_depth,
            },
            sequence,
        )
    };

    let result = emitter(&event);
    let mut guard = lock_unpoisoned(&shared.state);
    guard.emit_in_progress = false;
    match result {
        Ok(()) => {
            guard.state.commit_prepared(sequence, sample.instant)?;
            guard.prepared_event = None;
            drop(guard);
            shared.wake.notify_all();
            Ok(EmitOutcome::Emitted { sequence })
        }
        Err(error) => {
            guard.metrics.emit_failure_count = guard.metrics.emit_failure_count.saturating_add(1);
            if let Some(prepared) = guard.prepared_event.as_mut() {
                prepared.failed_attempts = prepared.failed_attempts.saturating_add(1);
            }
            drop(guard);
            shared.wake.notify_all();
            Ok(EmitOutcome::Failed { sequence, error })
        }
    }
}

fn output_worker<E>(shared: Weak<OutputPumpShared>, mut emitter: E)
where
    E: FnMut(&PtyDataBatchEvent) -> Result<(), String>,
{
    let _running = WorkerRunningGuard {
        shared: shared.clone(),
    };
    while let Some(shared) = shared.upgrade() {
        let guard = lock_unpoisoned(&shared.state);
        if guard.cancelled {
            return;
        }

        match synchronized_readiness(&guard, shared.clock.sample().instant) {
            BatchReadiness::Ready => {
                drop(guard);
                if emit_ready_shared(&shared, &mut emitter).is_err() {
                    let mut guard = lock_unpoisoned(&shared.state);
                    guard.metrics.worker_error_count =
                        guard.metrics.worker_error_count.saturating_add(1);
                    guard.cancelled = true;
                    drop(guard);
                    shared.wake.notify_all();
                    return;
                }
            }
            BatchReadiness::WaitingForCadence { remaining } => {
                drop(wait_timeout_unpoisoned(&shared.wake, guard, remaining));
            }
            BatchReadiness::Empty | BatchReadiness::InFlightFull => {
                drop(wait_unpoisoned(&shared.wake, guard));
            }
        }
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wait_unpoisoned<'a, T>(condition: &Condvar, guard: MutexGuard<'a, T>) -> MutexGuard<'a, T> {
    condition
        .wait(guard)
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wait_timeout_unpoisoned<'a, T>(
    condition: &Condvar,
    guard: MutexGuard<'a, T>,
    timeout: Duration,
) -> MutexGuard<'a, T> {
    match condition.wait_timeout(guard, timeout) {
        Ok((guard, _)) => guard,
        Err(poisoned) => poisoned.into_inner().0,
    }
}

fn validate_limit(
    field: &'static str,
    value: usize,
    hard_maximum: usize,
) -> Result<(), PumpLimitsError> {
    if value == 0 {
        return Err(PumpLimitsError::Zero { field });
    }
    if value > hard_maximum {
        return Err(PumpLimitsError::ExceedsHardMaximum {
            field,
            value,
            maximum: hard_maximum,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    #[derive(Debug)]
    struct TestClock {
        origin: Instant,
        elapsed: Mutex<Duration>,
    }

    impl TestClock {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                origin: Instant::now(),
                elapsed: Mutex::new(Duration::ZERO),
            })
        }

        fn advance(&self, duration: Duration) {
            let mut elapsed = self.elapsed.lock().unwrap();
            *elapsed += duration;
        }
    }

    impl PumpClock for TestClock {
        fn sample(&self) -> ClockSample {
            let elapsed = *self.elapsed.lock().unwrap();
            ClockSample {
                instant: self.origin + elapsed,
                micros: duration_micros(elapsed),
            }
        }
    }

    fn test_pump(thread_id: &str, limits: PumpLimits, clock: Arc<TestClock>) -> OutputPump {
        OutputPump::new_with_clock(thread_id.to_string(), limits, clock)
            .expect("test pump limits should be valid")
    }

    fn wait_for_blocked_producers(pump: &OutputPump, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(1);
        while pump.snapshot().blocked_producers != expected {
            assert!(
                Instant::now() < deadline,
                "producer did not reach the expected blocked state"
            );
            thread::yield_now();
        }
    }

    fn zero_cadence_limits() -> PumpLimits {
        PumpLimits {
            visible_cadence: Duration::ZERO,
            hidden_cadence: Duration::ZERO,
            ..PumpLimits::default()
        }
    }

    struct FakeExitHooks {
        clock: Arc<TestClock>,
        request_drain_elapsed: Duration,
        reader_outcome: CompletionOutcome,
        reader_elapsed: Duration,
        drain_outcome: DrainOutcome,
        drain_elapsed: Duration,
        worker_outcome: CompletionOutcome,
        worker_elapsed: Duration,
        reader_wait_budget: Option<Duration>,
        drain_wait_budget: Option<Duration>,
        worker_wait_budget: Option<Duration>,
        terminated_cleanup_budget: Option<Duration>,
        events: Vec<&'static str>,
        session_present: bool,
        timeout_count: u64,
    }

    impl FakeExitHooks {
        fn successful(clock: Arc<TestClock>) -> Self {
            Self {
                clock,
                request_drain_elapsed: Duration::ZERO,
                reader_outcome: CompletionOutcome::Completed,
                reader_elapsed: Duration::ZERO,
                drain_outcome: DrainOutcome::Drained,
                drain_elapsed: Duration::ZERO,
                worker_outcome: CompletionOutcome::Completed,
                worker_elapsed: Duration::ZERO,
                reader_wait_budget: None,
                drain_wait_budget: None,
                worker_wait_budget: None,
                terminated_cleanup_budget: None,
                events: Vec::new(),
                session_present: true,
                timeout_count: 0,
            }
        }

        fn advance_wait(&self, budget: Duration, elapsed: Duration, outcome: CompletionOutcome) {
            let elapsed = match outcome {
                CompletionOutcome::Completed => elapsed.min(budget),
                CompletionOutcome::TimedOut => budget,
            };
            self.clock.advance(elapsed);
        }
    }

    impl ExitShutdownHooks for FakeExitHooks {
        fn now(&self) -> Instant {
            self.clock.sample().instant
        }

        fn request_drain(&mut self) {
            assert!(self.session_present);
            self.events.push("request_drain");
            self.clock.advance(self.request_drain_elapsed);
        }

        fn wait_for_reader(&mut self, timeout: Duration) -> CompletionOutcome {
            assert!(self.session_present);
            self.events.push("wait_reader");
            self.reader_wait_budget = Some(timeout);
            self.advance_wait(timeout, self.reader_elapsed, self.reader_outcome);
            self.reader_outcome
        }

        fn join_reader(&mut self) {
            assert!(self.session_present);
            self.events.push("join_reader");
        }

        fn wait_for_drain(&mut self, timeout: Duration) -> DrainOutcome {
            assert!(self.session_present);
            self.events.push("wait_drain");
            self.drain_wait_budget = Some(timeout);
            let elapsed = match self.drain_outcome {
                DrainOutcome::Drained | DrainOutcome::Cancelled => self.drain_elapsed.min(timeout),
                DrainOutcome::TimedOut => timeout,
            };
            self.clock.advance(elapsed);
            self.drain_outcome
        }

        fn cancel_pump(&mut self) {
            self.events.push("cancel_pump");
        }

        fn wait_for_worker(&mut self, timeout: Duration) -> CompletionOutcome {
            self.events.push("wait_worker");
            self.worker_wait_budget = Some(timeout);
            self.advance_wait(timeout, self.worker_elapsed, self.worker_outcome);
            self.worker_outcome
        }

        fn join_worker(&mut self) {
            self.events.push("join_worker");
        }

        fn record_drain_timeout(&mut self) {
            self.events.push("record_timeout");
            self.timeout_count += 1;
        }

        fn terminate_process(&mut self) {
            self.events.push("terminate_process");
        }

        fn remove_session(&mut self) {
            assert!(self.session_present);
            self.events.push("remove_session");
            self.session_present = false;
        }

        fn finish_terminated_cleanup(&mut self, timeout: Duration) {
            assert!(!self.session_present);
            self.events.push("finish_terminated_cleanup");
            self.terminated_cleanup_budget = Some(timeout);
        }
    }

    struct BlockingProducerTimeoutHooks {
        clock: Arc<TestClock>,
        pump: OutputPump,
        session_present: bool,
    }

    impl ExitShutdownHooks for BlockingProducerTimeoutHooks {
        fn now(&self) -> Instant {
            self.clock.sample().instant
        }

        fn request_drain(&mut self) {
            assert!(self.session_present);
            self.pump.request_drain();
        }

        fn wait_for_reader(&mut self, timeout: Duration) -> CompletionOutcome {
            assert!(self.session_present);
            self.clock.advance(timeout);
            CompletionOutcome::TimedOut
        }

        fn join_reader(&mut self) {
            panic!("a timed-out reader must not be joined");
        }

        fn wait_for_drain(&mut self, _timeout: Duration) -> DrainOutcome {
            panic!("reader timeout must skip the drain wait");
        }

        fn cancel_pump(&mut self) {
            self.pump.cancel();
        }

        fn wait_for_worker(&mut self, _timeout: Duration) -> CompletionOutcome {
            panic!("reader timeout must skip the worker wait");
        }

        fn join_worker(&mut self) {
            panic!("reader timeout must not block joining the worker");
        }

        fn record_drain_timeout(&mut self) {
            self.pump.record_drain_timeout();
        }

        fn terminate_process(&mut self) {}

        fn remove_session(&mut self) {
            assert!(self.session_present);
            self.session_present = false;
        }

        fn finish_terminated_cleanup(&mut self, _timeout: Duration) {}
    }

    fn state_with_batch_bytes(max_batch_bytes: usize) -> PumpState {
        PumpState::new(PumpLimits {
            max_batch_bytes,
            ..PumpLimits::default()
        })
        .expect("test limits should be valid")
    }

    fn commit_next(
        state: &mut PumpState,
        now: Instant,
        visibility: PaneVisibility,
    ) -> Option<PtyBatch> {
        let prepared = state
            .prepare_batch(now, visibility)
            .expect("sequence should be available")?;
        Some(
            state
                .commit_prepared(prepared.sequence, now)
                .expect("prepared batch should commit"),
        )
    }

    #[test]
    fn default_limits_match_the_transport_contract() {
        let limits = PumpLimits::default();

        assert_eq!(limits.max_pending_bytes, 2 * 1024 * 1024);
        assert_eq!(limits.max_pending_fragments, 128);
        assert_eq!(limits.max_batch_bytes, 64 * 1024);
        assert_eq!(limits.max_in_flight, 2);
        assert_eq!(limits.visible_cadence, Duration::from_millis(16));
        assert_eq!(limits.hidden_cadence, Duration::from_millis(100));
        assert_eq!(limits.exit_drain_timeout, Duration::from_secs(2));
    }

    #[test]
    fn configured_limits_can_tighten_but_not_expand_hard_bounds() {
        let limits = PumpLimits {
            max_pending_bytes: 1,
            max_pending_fragments: 1,
            max_batch_bytes: 1,
            max_in_flight: 1,
            ..PumpLimits::default()
        };
        let state = PumpState::new(limits.clone()).expect("tighter limits should be valid");
        assert_eq!(state.limits(), &limits);

        assert_eq!(
            PumpState::new(PumpLimits {
                max_in_flight: MAX_IN_FLIGHT + 1,
                ..PumpLimits::default()
            })
            .unwrap_err(),
            PumpLimitsError::ExceedsHardMaximum {
                field: "max_in_flight",
                value: MAX_IN_FLIGHT + 1,
                maximum: MAX_IN_FLIGHT
            }
        );
    }

    #[test]
    fn batches_cross_fragment_boundaries_in_exact_byte_order() {
        let mut state = PumpState::default();
        let now = Instant::now();

        state
            .push(vec![1; MAX_BATCH_BYTES - 1])
            .expect("first fragment should fit");
        state.push(vec![2, 2]).expect("second fragment should fit");

        let first =
            commit_next(&mut state, now, PaneVisibility::Visible).expect("batch should be ready");
        assert_eq!(first.sequence, 1);
        assert_eq!(first.data.len(), MAX_BATCH_BYTES);
        assert!(first.data[..MAX_BATCH_BYTES - 1]
            .iter()
            .all(|byte| *byte == 1));
        assert_eq!(first.data[MAX_BATCH_BYTES - 1], 2);

        assert!(matches!(
            state
                .acknowledge(1, now + Duration::from_millis(1))
                .expect("exact acknowledgement should advance"),
            AckOutcome::Advanced {
                sequence: 1,
                bytes: MAX_BATCH_BYTES,
                ..
            }
        ));

        let second = commit_next(&mut state, now + VISIBLE_CADENCE, PaneVisibility::Visible)
            .expect("remaining byte should be ready");
        assert_eq!(second.sequence, 2);
        assert_eq!(second.data.as_ref(), &[2]);
    }

    #[test]
    fn never_emits_more_than_two_unacknowledged_batches() {
        let mut state = PumpState::default();
        let now = Instant::now();
        state
            .push(vec![7; MAX_BATCH_BYTES * 3])
            .expect("input should fit pending budget");

        let first = commit_next(&mut state, now, PaneVisibility::Visible).unwrap();
        let second =
            commit_next(&mut state, now + VISIBLE_CADENCE, PaneVisibility::Visible).unwrap();

        assert_eq!((first.sequence, second.sequence), (1, 2));
        assert_eq!(state.in_flight_len(), MAX_IN_FLIGHT);
        assert_eq!(
            state.readiness(now + VISIBLE_CADENCE * 2, PaneVisibility::Visible),
            BatchReadiness::InFlightFull
        );
        assert!(commit_next(
            &mut state,
            now + VISIBLE_CADENCE * 2,
            PaneVisibility::Visible,
        )
        .is_none());

        state
            .acknowledge(1, now + VISIBLE_CADENCE * 2)
            .expect("oldest batch acknowledgement should advance");
        let third = commit_next(
            &mut state,
            now + VISIBLE_CADENCE * 2,
            PaneVisibility::Visible,
        )
        .expect("capacity should reopen after acknowledgement");
        assert_eq!(third.sequence, 3);
        assert_eq!(state.in_flight_len(), MAX_IN_FLIGHT);
    }

    #[test]
    fn byte_and_fragment_budgets_block_before_they_are_exceeded() {
        let mut byte_limited = PumpState::default();
        byte_limited
            .push(vec![3; MAX_PENDING_BYTES])
            .expect("exact byte budget should be accepted");

        assert!(matches!(
            byte_limited.push(vec![4]),
            Err(PushError::WouldBlock {
                budget: CapacityBudget::Bytes,
                ..
            })
        ));
        assert_eq!(byte_limited.pending_bytes(), MAX_PENDING_BYTES);
        assert_eq!(byte_limited.pending_fragments(), 1);
        assert_eq!(
            byte_limited.metrics().bytes_accepted,
            MAX_PENDING_BYTES as u64
        );
        assert_eq!(byte_limited.metrics().push_would_block_count, 1);
        assert_eq!(
            byte_limited.metrics().pending_bytes_high_water,
            MAX_PENDING_BYTES
        );

        let mut fragment_limited = PumpState::default();
        for value in 0..MAX_PENDING_FRAGMENTS {
            fragment_limited
                .push(vec![(value % 256) as u8])
                .expect("fragment within exact budget should be accepted");
        }

        assert!(matches!(
            fragment_limited.push(vec![9]),
            Err(PushError::WouldBlock {
                budget: CapacityBudget::Fragments,
                ..
            })
        ));
        assert_eq!(fragment_limited.pending_fragments(), MAX_PENDING_FRAGMENTS);
        assert_eq!(fragment_limited.pending_bytes(), MAX_PENDING_FRAGMENTS);
        assert_eq!(
            fragment_limited.metrics().pending_fragments_high_water,
            MAX_PENDING_FRAGMENTS
        );
    }

    #[test]
    fn acknowledgements_are_exact_idempotent_and_ordered() {
        let mut state = state_with_batch_bytes(2);
        let now = Instant::now();
        state.push(vec![1, 2, 3, 4]).unwrap();
        commit_next(&mut state, now, PaneVisibility::Visible).unwrap();
        commit_next(&mut state, now + VISIBLE_CADENCE, PaneVisibility::Visible).unwrap();

        assert_eq!(
            state.acknowledge(0, now + Duration::from_millis(20)),
            Err(AckError::Unknown { received: 0 })
        );
        assert_eq!(
            state.acknowledge(2, now + Duration::from_millis(20)),
            Err(AckError::Skipped {
                expected: 1,
                received: 2
            })
        );
        assert_eq!(
            state.acknowledge(3, now + Duration::from_millis(20)),
            Err(AckError::Future {
                highest_emitted: 2,
                received: 3
            })
        );
        assert_eq!(state.in_flight_len(), 2);
        assert_eq!(state.last_acked_sequence(), 0);

        assert!(matches!(
            state
                .acknowledge(1, now + Duration::from_millis(20))
                .unwrap(),
            AckOutcome::Advanced {
                sequence: 1,
                bytes: 2,
                ..
            }
        ));
        assert_eq!(
            state
                .acknowledge(1, now + Duration::from_millis(21))
                .unwrap(),
            AckOutcome::Duplicate { sequence: 1 }
        );
        assert!(matches!(
            state
                .acknowledge(2, now + Duration::from_millis(22))
                .unwrap(),
            AckOutcome::Advanced {
                sequence: 2,
                bytes: 2,
                ..
            }
        ));
        assert_eq!(state.last_acked_sequence(), 2);
        assert_eq!(state.in_flight_len(), 0);
    }

    #[test]
    fn acknowledgement_time_before_emission_does_not_advance() {
        let mut state = PumpState::default();
        let emitted_at = Instant::now();
        state.push(vec![1]).unwrap();
        commit_next(&mut state, emitted_at, PaneVisibility::Visible).unwrap();

        assert_eq!(
            state.acknowledge(1, emitted_at - Duration::from_millis(1)),
            Err(AckError::ClockBeforeEmission { sequence: 1 })
        );
        assert_eq!(state.last_acked_sequence(), 0);
        assert_eq!(state.in_flight_len(), 1);
        assert_eq!(state.metrics().bytes_acknowledged, 0);
    }

    #[test]
    fn zero_length_fragments_are_accepted_as_no_ops() {
        let mut state = PumpState::default();

        state
            .push(Vec::new())
            .expect("empty input should be a no-op");

        assert_eq!(state.pending_bytes(), 0);
        assert_eq!(state.pending_fragments(), 0);
        assert_eq!(state.metrics().bytes_accepted, 0);
        assert!(commit_next(&mut state, Instant::now(), PaneVisibility::Visible).is_none());
    }

    #[test]
    fn one_batch_drains_multiple_fragments_and_preserves_remainders() {
        let mut state = state_with_batch_bytes(4);
        let now = Instant::now();
        state.push(b"ab".to_vec()).unwrap();
        state.push(b"cde".to_vec()).unwrap();
        state.push(b"f".to_vec()).unwrap();

        let first = commit_next(&mut state, now, PaneVisibility::Visible).unwrap();
        assert_eq!(first.data.as_ref(), b"abcd");
        assert_eq!(state.pending_bytes(), 2);
        assert_eq!(state.pending_fragments(), 2);

        state
            .acknowledge(1, now + Duration::from_millis(1))
            .unwrap();
        let second =
            commit_next(&mut state, now + VISIBLE_CADENCE, PaneVisibility::Visible).unwrap();
        assert_eq!(second.data.as_ref(), b"ef");
        assert_eq!(state.pending_bytes(), 0);
        assert_eq!(state.pending_fragments(), 0);
    }

    #[test]
    fn queue_and_in_flight_accounting_changes_only_on_emit_and_ack() {
        let mut state = state_with_batch_bytes(4);
        let now = Instant::now();
        state.push(vec![1, 2, 3]).unwrap();
        state.push(vec![4, 5]).unwrap();

        assert_eq!(state.pending_bytes(), 5);
        assert_eq!(state.pending_fragments(), 2);
        assert_eq!(state.in_flight_bytes(), 0);

        commit_next(&mut state, now, PaneVisibility::Visible).unwrap();
        assert_eq!(state.pending_bytes(), 1);
        assert_eq!(state.pending_fragments(), 1);
        assert_eq!(state.in_flight_bytes(), 4);
        assert_eq!(state.metrics().bytes_emitted, 4);

        state
            .acknowledge(1, now + Duration::from_millis(3))
            .unwrap();
        assert_eq!(state.pending_bytes(), 1);
        assert_eq!(state.pending_fragments(), 1);
        assert_eq!(state.in_flight_bytes(), 0);
        assert_eq!(state.metrics().bytes_acknowledged, 4);
    }

    #[test]
    fn cadence_eligibility_uses_visible_and_hidden_intervals() {
        let now = Instant::now();

        let mut visible = state_with_batch_bytes(1);
        visible.push(vec![1, 2]).unwrap();
        commit_next(&mut visible, now, PaneVisibility::Visible).unwrap();
        visible
            .acknowledge(1, now + Duration::from_millis(1))
            .unwrap();
        assert_eq!(
            visible.readiness(now + Duration::from_millis(15), PaneVisibility::Visible),
            BatchReadiness::WaitingForCadence {
                remaining: Duration::from_millis(1)
            }
        );
        assert_eq!(
            visible.readiness(now + Duration::from_millis(16), PaneVisibility::Visible),
            BatchReadiness::Ready
        );

        let mut hidden = state_with_batch_bytes(1);
        hidden.push(vec![1, 2]).unwrap();
        commit_next(&mut hidden, now, PaneVisibility::Hidden).unwrap();
        hidden
            .acknowledge(1, now + Duration::from_millis(1))
            .unwrap();
        assert_eq!(
            hidden.readiness(now + Duration::from_millis(99), PaneVisibility::Hidden),
            BatchReadiness::WaitingForCadence {
                remaining: Duration::from_millis(1)
            }
        );
        assert_eq!(
            hidden.readiness(now + Duration::from_millis(100), PaneVisibility::Hidden),
            BatchReadiness::Ready
        );
    }

    #[test]
    fn metrics_track_averages_and_bounded_high_water_marks() {
        let mut state = PumpState::new(PumpLimits {
            max_pending_bytes: 5,
            max_pending_fragments: 2,
            max_batch_bytes: 4,
            max_in_flight: 2,
            visible_cadence: Duration::ZERO,
            hidden_cadence: Duration::ZERO,
            exit_drain_timeout: EXIT_DRAIN_TIMEOUT,
        })
        .unwrap();
        let now = Instant::now();

        state.push(b"abc".to_vec()).unwrap();
        state.push(b"de".to_vec()).unwrap();
        commit_next(&mut state, now, PaneVisibility::Visible).unwrap();
        state.push(b"fghi".to_vec()).unwrap();
        commit_next(&mut state, now, PaneVisibility::Visible).unwrap();

        assert_eq!(state.metrics().pending_bytes_high_water, 5);
        assert_eq!(state.metrics().pending_fragments_high_water, 2);
        assert_eq!(state.metrics().in_flight_batches_high_water, 2);
        assert_eq!(state.metrics().in_flight_bytes_high_water, 8);
        assert_eq!(state.metrics().average_batch_bytes(), Some(4.0));

        state
            .acknowledge(1, now + Duration::from_millis(5))
            .unwrap();
        state
            .acknowledge(2, now + Duration::from_millis(10))
            .unwrap();

        assert_eq!(
            state.metrics().average_ack_latency(),
            Some(Duration::from_micros(7_500))
        );
        assert_eq!(state.metrics().max_ack_latency, Duration::from_millis(10));
        assert_eq!(state.metrics().bytes_accepted, 9);
        assert_eq!(state.metrics().bytes_emitted, 8);
        assert_eq!(state.metrics().batches_emitted, 2);
        assert_eq!(state.metrics().batches_acknowledged, 2);
    }

    #[test]
    fn failed_delivery_reuses_prepared_sequence_and_bytes_without_committing_emission() {
        let mut state = PumpState::default();
        let now = Instant::now();
        state.push(b"retry exactly".to_vec()).unwrap();

        let first_attempt = state
            .prepare_batch(now, PaneVisibility::Visible)
            .unwrap()
            .unwrap();
        let retry = state
            .prepare_batch(now + Duration::from_millis(1), PaneVisibility::Visible)
            .unwrap()
            .unwrap();

        assert_eq!(first_attempt.sequence, 1);
        assert_eq!(retry.sequence, first_attempt.sequence);
        assert_eq!(retry.data.as_ref(), first_attempt.data.as_ref());
        assert!(Arc::ptr_eq(&retry.data, &first_attempt.data));
        assert_eq!(state.in_flight_len(), 0);
        assert_eq!(state.last_emitted_at(), None);
        assert_eq!(state.metrics().bytes_emitted, 0);
        assert_eq!(state.metrics().batches_emitted, 0);
        assert_eq!(
            state.readiness(now, PaneVisibility::Visible),
            BatchReadiness::Ready
        );
    }

    #[test]
    fn commit_after_failed_delivery_records_exactly_one_emission() {
        let mut state = PumpState::default();
        let now = Instant::now();
        state.push(b"commit once".to_vec()).unwrap();

        let first_attempt = state
            .prepare_batch(now, PaneVisibility::Visible)
            .unwrap()
            .unwrap();
        let retry = state
            .prepare_batch(now + Duration::from_millis(1), PaneVisibility::Visible)
            .unwrap()
            .unwrap();
        let committed = state
            .commit_prepared(retry.sequence, now + Duration::from_millis(2))
            .unwrap();

        assert_eq!(committed.sequence, first_attempt.sequence);
        assert!(Arc::ptr_eq(&committed.data, &first_attempt.data));
        assert_eq!(state.in_flight_len(), 1);
        assert_eq!(
            state.metrics().bytes_emitted,
            first_attempt.data.len() as u64
        );
        assert_eq!(state.metrics().batches_emitted, 1);
        assert_eq!(
            state.commit_prepared(retry.sequence, now + Duration::from_millis(3)),
            Err(CommitError::NoPreparedBatch)
        );
        assert_eq!(state.in_flight_len(), 1);
        assert_eq!(state.metrics().batches_emitted, 1);
    }

    #[test]
    fn repeated_failed_deliveries_never_fill_the_in_flight_window() {
        let mut state = PumpState::new(PumpLimits {
            max_in_flight: 1,
            ..PumpLimits::default()
        })
        .unwrap();
        let now = Instant::now();
        state.push(b"still pending".to_vec()).unwrap();

        for attempt in 0..2 {
            let prepared = state
                .prepare_batch(
                    now + Duration::from_millis(attempt),
                    PaneVisibility::Visible,
                )
                .unwrap()
                .unwrap();
            assert_eq!(prepared.sequence, 1);
            assert_eq!(state.in_flight_len(), 0);
            assert_ne!(
                state.readiness(now, PaneVisibility::Visible),
                BatchReadiness::InFlightFull
            );
        }
    }

    #[test]
    fn one_large_owned_fragment_advances_a_cursor_across_many_batches() {
        let mut state = PumpState::new(PumpLimits {
            max_pending_bytes: 10,
            max_pending_fragments: 1,
            max_batch_bytes: 3,
            max_in_flight: 1,
            visible_cadence: Duration::ZERO,
            hidden_cadence: Duration::ZERO,
            exit_drain_timeout: EXIT_DRAIN_TIMEOUT,
        })
        .unwrap();
        let now = Instant::now();
        state.push((0_u8..10).collect::<Vec<_>>()).unwrap();
        let mut emitted = Vec::new();

        for (batch_index, expected_consumed) in [3, 6, 9, 10].into_iter().enumerate() {
            let prepared = state
                .prepare_batch(now, PaneVisibility::Visible)
                .unwrap()
                .unwrap();
            emitted.extend_from_slice(&prepared.data);

            if expected_consumed < 10 {
                assert_eq!(
                    state.oldest_queued_fragment_progress(),
                    Some(PendingFragmentProgress {
                        consumed_bytes: expected_consumed,
                        remaining_bytes: 10 - expected_consumed,
                        total_bytes: 10,
                    })
                );
                assert_eq!(state.pending_fragments(), 1);
            } else {
                assert_eq!(state.oldest_queued_fragment_progress(), None);
                assert_eq!(state.pending_fragments(), 1);
            }

            let sequence = prepared.sequence;
            state.commit_prepared(sequence, now).unwrap();
            state.acknowledge(sequence, now).unwrap();
            assert_eq!(sequence, batch_index as u64 + 1);
            if expected_consumed == 10 {
                assert_eq!(state.pending_fragments(), 0);
            }
        }

        assert_eq!(emitted, (0_u8..10).collect::<Vec<_>>());
        assert_eq!(state.pending_bytes(), 0);
    }

    #[test]
    fn oversized_fragment_is_a_permanent_error_without_state_or_metric_changes() {
        let mut state = PumpState::new(PumpLimits {
            max_pending_bytes: 4,
            ..PumpLimits::default()
        })
        .unwrap();

        assert_eq!(
            state.push(vec![1, 2, 3, 4, 5]),
            Err(PushError::OversizedFragment {
                fragment: vec![1, 2, 3, 4, 5],
                incoming_bytes: 5,
                max_pending_bytes: 4,
            })
        );
        assert_eq!(state.pending_bytes(), 0);
        assert_eq!(state.pending_fragments(), 0);
        assert_eq!(state.metrics(), &PumpMetrics::default());
    }

    #[test]
    fn transient_would_block_counts_bytes_only_after_retry_is_accepted() {
        let mut state = PumpState::new(PumpLimits {
            max_pending_bytes: 4,
            max_pending_fragments: 2,
            max_batch_bytes: 4,
            max_in_flight: 1,
            visible_cadence: Duration::ZERO,
            hidden_cadence: Duration::ZERO,
            exit_drain_timeout: EXIT_DRAIN_TIMEOUT,
        })
        .unwrap();
        let now = Instant::now();
        state.push(vec![1, 2, 3, 4]).unwrap();

        let retry = match state.push(vec![5]) {
            Err(PushError::WouldBlock {
                fragment,
                budget: CapacityBudget::Bytes,
                ..
            }) => fragment,
            other => panic!("expected transient byte backpressure, got {other:?}"),
        };
        assert_eq!(state.metrics().bytes_accepted, 4);
        assert_eq!(state.metrics().fragments_accepted, 1);

        let prepared = state
            .prepare_batch(now, PaneVisibility::Visible)
            .unwrap()
            .unwrap();
        state.commit_prepared(prepared.sequence, now).unwrap();
        state.acknowledge(prepared.sequence, now).unwrap();
        state.push(retry).unwrap();

        assert_eq!(state.metrics().bytes_accepted, 5);
        assert_eq!(state.metrics().fragments_accepted, 2);
        assert_eq!(state.metrics().push_would_block_count, 1);
    }

    #[test]
    fn prepared_retention_stays_inside_pending_byte_and_fragment_budgets() {
        let mut state = PumpState::new(PumpLimits {
            max_pending_bytes: 1,
            max_pending_fragments: 1,
            max_batch_bytes: 1,
            max_in_flight: 1,
            visible_cadence: Duration::ZERO,
            hidden_cadence: Duration::ZERO,
            exit_drain_timeout: EXIT_DRAIN_TIMEOUT,
        })
        .unwrap();
        let now = Instant::now();
        state.push(vec![1]).unwrap();
        let prepared = state
            .prepare_batch(now, PaneVisibility::Visible)
            .unwrap()
            .unwrap();

        let retry = match state.push(vec![2]) {
            Err(PushError::WouldBlock {
                fragment,
                budget: CapacityBudget::BytesAndFragments,
                ..
            }) => fragment,
            other => panic!("prepared bytes and fragment should retain both budgets: {other:?}"),
        };
        assert_eq!(state.pending_bytes(), 1);
        assert_eq!(state.pending_fragments(), 1);

        state.commit_prepared(prepared.sequence, now).unwrap();
        state.push(retry).unwrap();
        assert_eq!(state.pending_bytes(), 1);
        assert_eq!(state.pending_fragments(), 1);
    }

    #[test]
    fn producer_blocks_at_byte_or_fragment_budget_until_capacity_is_released() {
        let cases = [
            (
                PumpLimits {
                    max_pending_bytes: 2,
                    max_pending_fragments: 2,
                    max_batch_bytes: 2,
                    max_in_flight: 1,
                    visible_cadence: Duration::ZERO,
                    hidden_cadence: Duration::ZERO,
                    exit_drain_timeout: EXIT_DRAIN_TIMEOUT,
                },
                vec![1, 2],
                vec![3],
            ),
            (
                PumpLimits {
                    max_pending_bytes: 2,
                    max_pending_fragments: 1,
                    max_batch_bytes: 1,
                    max_in_flight: 1,
                    visible_cadence: Duration::ZERO,
                    hidden_cadence: Duration::ZERO,
                    exit_drain_timeout: EXIT_DRAIN_TIMEOUT,
                },
                vec![1],
                vec![2],
            ),
        ];

        for (index, (limits, initial, blocked)) in cases.into_iter().enumerate() {
            let clock = TestClock::new();
            let pump = test_pump(&format!("budget-{index}"), limits, Arc::clone(&clock));
            pump.enqueue(initial).unwrap();

            let producer_pump = pump.clone();
            let producer = thread::spawn(move || producer_pump.enqueue(blocked));
            wait_for_blocked_producers(&pump, 1);
            assert!(!producer.is_finished());

            clock.advance(Duration::from_millis(7));
            assert_eq!(
                pump.emit_ready(|_| Ok(())),
                Ok(EmitOutcome::Emitted { sequence: 1 })
            );
            producer.join().unwrap().unwrap();

            let snapshot = pump.snapshot();
            assert_eq!(snapshot.blocked_producers, 0);
            assert_eq!(snapshot.metrics.blocked_reader_count, 1);
            assert_eq!(
                snapshot.metrics.total_blocked_reader_duration,
                Duration::from_millis(7)
            );
            assert_eq!(
                snapshot.metrics.max_blocked_reader_duration,
                Duration::from_millis(7)
            );
        }
    }

    #[test]
    fn slow_pane_does_not_consume_another_panes_queue_or_in_flight_window() {
        let clock = TestClock::new();
        let limits = PumpLimits {
            max_pending_bytes: 2,
            max_pending_fragments: 2,
            max_batch_bytes: 1,
            max_in_flight: 1,
            visible_cadence: Duration::ZERO,
            hidden_cadence: Duration::ZERO,
            exit_drain_timeout: EXIT_DRAIN_TIMEOUT,
        };
        let slow = test_pump("slow", limits.clone(), Arc::clone(&clock));
        let ready = test_pump("ready", limits, Arc::clone(&clock));

        slow.enqueue(vec![1, 2]).unwrap();
        assert_eq!(
            slow.emit_ready(|_| Ok(())),
            Ok(EmitOutcome::Emitted { sequence: 1 })
        );
        assert_eq!(slow.snapshot().in_flight_batches, 1);
        assert_eq!(slow.snapshot().queued_bytes, 1);

        let mut ready_event = None;
        ready.enqueue(b"ok".to_vec()).unwrap();
        assert_eq!(
            ready.emit_ready(|event| {
                ready_event = Some((event.thread_id.clone(), event.sequence, event.bytes.clone()));
                Ok(())
            }),
            Ok(EmitOutcome::Emitted { sequence: 1 })
        );

        assert_eq!(ready_event, Some(("ready".to_string(), 1, vec![b'o'])));
        assert_eq!(ready.snapshot().in_flight_batches, 1);
        assert_eq!(ready.snapshot().queued_bytes, 1);
        assert_eq!(slow.snapshot().in_flight_batches, 1);
        assert_eq!(slow.snapshot().queued_bytes, 1);
    }

    #[test]
    fn visibility_changes_cadence_and_wakes_only_on_actual_transitions() {
        let clock = TestClock::new();
        let pump = test_pump(
            "visibility",
            PumpLimits {
                max_batch_bytes: 1,
                ..PumpLimits::default()
            },
            Arc::clone(&clock),
        );

        assert_eq!(pump.snapshot().effective_cadence, VISIBLE_CADENCE);
        assert!(!pump.set_visibility(PaneVisibility::Visible));
        assert_eq!(pump.snapshot().metrics.visibility_transition_count, 0);

        pump.enqueue(vec![1, 2]).unwrap();
        assert_eq!(
            pump.emit_ready(|_| Ok(())),
            Ok(EmitOutcome::Emitted { sequence: 1 })
        );
        pump.acknowledge(1).unwrap();
        clock.advance(VISIBLE_CADENCE);

        assert!(pump.set_visibility(PaneVisibility::Hidden));
        let hidden = pump.snapshot();
        assert_eq!(hidden.effective_cadence, HIDDEN_CADENCE);
        assert_eq!(hidden.metrics.visibility_transition_count, 1);
        assert!(!pump.set_visibility(PaneVisibility::Hidden));
        assert_eq!(pump.snapshot().metrics.visibility_transition_count, 1);
        assert_eq!(
            pump.emit_ready(|_| Ok(())),
            Ok(EmitOutcome::NotReady(BatchReadiness::WaitingForCadence {
                remaining: HIDDEN_CADENCE - VISIBLE_CADENCE,
            }))
        );

        clock.advance(HIDDEN_CADENCE - VISIBLE_CADENCE);
        assert_eq!(
            pump.emit_ready(|_| Ok(())),
            Ok(EmitOutcome::Emitted { sequence: 2 })
        );
    }

    #[test]
    fn failed_emit_reuses_sequence_and_bytes_with_a_fresh_attempt_timestamp() {
        let clock = TestClock::new();
        let pump = test_pump("retry", PumpLimits::default(), Arc::clone(&clock));
        pump.enqueue(b"retry exactly".to_vec()).unwrap();

        let mut first = None;
        assert!(matches!(
            pump.emit_ready(|event| {
                first = Some((
                    event.sequence,
                    event.bytes.clone(),
                    event.emitted_at_micros,
                ));
                Err("transient".to_string())
            }),
            Ok(EmitOutcome::Failed {
                sequence: 1,
                error
            }) if error == "transient"
        ));
        let failed = pump.snapshot();
        assert!(failed.prepared);
        assert_eq!(failed.in_flight_batches, 0);
        assert_eq!(failed.metrics.state.bytes_emitted, 0);
        assert_eq!(failed.metrics.state.batches_emitted, 0);
        assert_eq!(failed.metrics.emit_failure_count, 1);
        assert_eq!(failed.metrics.emit_retry_count, 0);

        clock.advance(VISIBLE_CADENCE);
        let mut retry = None;
        assert_eq!(
            pump.emit_ready(|event| {
                retry = Some((event.sequence, event.bytes.clone(), event.emitted_at_micros));
                clock.advance(Duration::from_millis(5));
                Ok(())
            }),
            Ok(EmitOutcome::Emitted { sequence: 1 })
        );

        let first = first.unwrap();
        let retry = retry.unwrap();
        assert_eq!(retry.0, first.0);
        assert_eq!(retry.1, first.1);
        assert_eq!(first.2, 0);
        assert_eq!(retry.2, duration_micros(VISIBLE_CADENCE));
        assert_eq!(
            pump.acknowledge(1),
            Ok(AckOutcome::Advanced {
                sequence: 1,
                bytes: b"retry exactly".len(),
                emitted_at: clock.origin + VISIBLE_CADENCE,
                acknowledged_at: clock.origin + VISIBLE_CADENCE + Duration::from_millis(5),
                latency: Duration::from_millis(5),
            })
        );
        let committed = pump.snapshot();
        assert!(!committed.prepared);
        assert_eq!(committed.in_flight_batches, 0);
        assert_eq!(
            committed.metrics.state.bytes_emitted,
            b"retry exactly".len() as u64
        );
        assert_eq!(committed.metrics.state.batches_emitted, 1);
        assert_eq!(committed.metrics.state.batches_acknowledged, 1);
        assert_eq!(
            committed.metrics.state.total_ack_latency,
            Duration::from_millis(5)
        );
        assert_eq!(committed.metrics.emit_failure_count, 1);
        assert_eq!(committed.metrics.emit_retry_count, 1);
    }

    #[test]
    fn final_snapshots_survive_session_removal_with_transport_outcomes() {
        let clock = TestClock::new();
        let pump = test_pump("snapshot", zero_cadence_limits(), Arc::clone(&clock));
        pump.enqueue(vec![1]).unwrap();
        assert!(matches!(
            pump.emit_ready(|_| Err("transient".to_string())),
            Ok(EmitOutcome::Failed { sequence: 1, .. })
        ));
        assert_eq!(
            pump.emit_ready(|_| Ok(())),
            Ok(EmitOutcome::Emitted { sequence: 1 })
        );
        clock.advance(Duration::from_millis(3));
        pump.acknowledge(1).unwrap();
        pump.record_drain_timeout();

        let mut transport = pump.snapshot();
        transport.metrics.blocked_reader_count = 2;
        transport.metrics.total_blocked_reader_duration = Duration::from_millis(9);
        transport.metrics.max_blocked_reader_duration = Duration::from_millis(6);
        let final_snapshot = FinalOutputPumpSnapshot {
            key: TransportSessionKey::new("snapshot", 7),
            outcome: ExitShutdownOutcome::TimedOut,
            transport,
        };
        let mut recent = RecentOutputSnapshots::new(2).unwrap();
        recent.insert(final_snapshot.clone());
        drop(pump);

        let retained = recent
            .get(&TransportSessionKey::new("snapshot", 7))
            .expect("removed session snapshot must remain retrievable");
        assert_eq!(retained, &final_snapshot);
        assert_eq!(retained.transport.metrics.emit_failure_count, 1);
        assert_eq!(retained.transport.metrics.emit_retry_count, 1);
        assert_eq!(retained.transport.metrics.blocked_reader_count, 2);
        assert_eq!(
            retained.transport.metrics.total_blocked_reader_duration,
            Duration::from_millis(9)
        );
        assert_eq!(retained.transport.metrics.state.batches_acknowledged, 1);
        assert_eq!(
            retained.transport.metrics.state.total_ack_latency,
            Duration::from_millis(3)
        );
        assert_eq!(retained.transport.metrics.drain_timeout_count, 1);
    }

    #[test]
    fn recent_snapshot_retention_is_bounded_and_generation_safe() {
        let pump = test_pump("same-id", zero_cadence_limits(), TestClock::new());
        let transport = pump.snapshot();
        let mut recent = RecentOutputSnapshots::new(2).unwrap();

        for generation in 1..=3 {
            recent.insert(FinalOutputPumpSnapshot {
                key: TransportSessionKey::new("same-id", generation),
                outcome: ExitShutdownOutcome::Drained,
                transport: transport.clone(),
            });
        }

        assert_eq!(recent.len(), 2);
        assert!(recent
            .get(&TransportSessionKey::new("same-id", 1))
            .is_none());
        assert_eq!(
            recent
                .get(&TransportSessionKey::new("same-id", 2))
                .unwrap()
                .key
                .generation,
            2
        );
        assert_eq!(
            recent.latest_for_thread("same-id").unwrap().key.generation,
            3
        );
        let error = RecentOutputSnapshots::new(MAX_RECENT_OUTPUT_SNAPSHOTS + 1).unwrap_err();
        assert_eq!(
            error,
            RecentSnapshotStoreError::CapacityExceedsMaximum {
                requested: MAX_RECENT_OUTPUT_SNAPSHOTS + 1,
                maximum: MAX_RECENT_OUTPUT_SNAPSHOTS,
            }
        );
    }

    #[test]
    fn exit_drain_waits_for_queued_prepared_and_in_flight_data_and_records_timeouts() {
        let clock = TestClock::new();
        let pump = test_pump("drain", zero_cadence_limits(), Arc::clone(&clock));
        pump.enqueue(b"queued".to_vec()).unwrap();
        pump.request_drain();

        assert_eq!(
            pump.wait_for_drain_timeout(Duration::ZERO),
            DrainOutcome::TimedOut
        );
        assert_eq!(pump.snapshot().metrics.drain_timeout_count, 1);

        assert!(matches!(
            pump.emit_ready(|_| Err("not yet".to_string())),
            Ok(EmitOutcome::Failed { sequence: 1, .. })
        ));
        assert!(pump.snapshot().prepared);
        assert_eq!(
            pump.wait_for_drain_timeout(Duration::ZERO),
            DrainOutcome::TimedOut
        );

        assert_eq!(
            pump.emit_ready(|_| Ok(())),
            Ok(EmitOutcome::Emitted { sequence: 1 })
        );
        assert_eq!(pump.snapshot().in_flight_batches, 1);
        assert_eq!(
            pump.wait_for_drain_timeout(Duration::ZERO),
            DrainOutcome::TimedOut
        );

        pump.acknowledge(1).unwrap();
        assert_eq!(
            pump.wait_for_drain_timeout(Duration::ZERO),
            DrainOutcome::Drained
        );
        let drained = pump.snapshot();
        assert!(drained.draining);
        assert!(drained.is_empty());
        assert_eq!(drained.metrics.drain_timeout_count, 3);
    }

    #[test]
    fn exit_deadline_starts_before_waiting_for_a_blocked_reader() {
        let clock = TestClock::new();
        let mut hooks = FakeExitHooks::successful(Arc::clone(&clock));
        hooks.request_drain_elapsed = Duration::from_millis(250);
        hooks.reader_outcome = CompletionOutcome::TimedOut;

        assert_eq!(
            coordinate_exit_shutdown(&mut hooks, EXIT_DRAIN_TIMEOUT),
            ExitShutdownOutcome::TimedOut
        );
        assert_eq!(hooks.reader_wait_budget, Some(Duration::from_millis(1_750)));
        assert_eq!(
            clock.sample().instant.duration_since(clock.origin),
            EXIT_DRAIN_TIMEOUT
        );
        assert_eq!(
            hooks.events,
            vec![
                "request_drain",
                "wait_reader",
                "record_timeout",
                "terminate_process",
                "cancel_pump",
                "remove_session",
                "finish_terminated_cleanup",
            ]
        );
        assert_eq!(
            hooks.terminated_cleanup_budget,
            Some(EXIT_TERMINATION_CLEANUP_TIMEOUT)
        );
    }

    #[test]
    fn session_remains_routable_until_reader_and_acknowledgement_drain_complete() {
        let clock = TestClock::new();
        let mut hooks = FakeExitHooks::successful(clock);
        hooks.reader_elapsed = Duration::from_millis(300);
        hooks.drain_elapsed = Duration::from_millis(400);
        hooks.worker_elapsed = Duration::from_millis(50);

        assert_eq!(
            coordinate_exit_shutdown(&mut hooks, EXIT_DRAIN_TIMEOUT),
            ExitShutdownOutcome::Drained
        );
        assert!(!hooks.session_present);
        assert_eq!(
            hooks.events,
            vec![
                "request_drain",
                "wait_reader",
                "join_reader",
                "wait_drain",
                "cancel_pump",
                "wait_worker",
                "join_worker",
                "remove_session",
            ]
        );
    }

    #[test]
    fn completed_reader_and_acknowledged_drain_finish_without_timeout() {
        let clock = TestClock::new();
        let mut hooks = FakeExitHooks::successful(clock);
        hooks.reader_elapsed = Duration::from_millis(500);
        hooks.drain_elapsed = Duration::from_millis(1_200);
        hooks.worker_elapsed = Duration::from_millis(100);

        assert_eq!(
            coordinate_exit_shutdown(&mut hooks, EXIT_DRAIN_TIMEOUT),
            ExitShutdownOutcome::Drained
        );
        assert_eq!(hooks.reader_wait_budget, Some(EXIT_DRAIN_TIMEOUT));
        assert_eq!(hooks.drain_wait_budget, Some(Duration::from_millis(1_500)));
        assert_eq!(hooks.worker_wait_budget, Some(Duration::from_millis(300)));
        assert_eq!(hooks.timeout_count, 0);
    }

    #[test]
    fn stop_cancellation_finishes_reader_and_worker_coordination() {
        let clock = TestClock::new();
        let mut hooks = FakeExitHooks::successful(clock);
        hooks.drain_outcome = DrainOutcome::Cancelled;

        assert_eq!(
            coordinate_exit_shutdown(&mut hooks, EXIT_DRAIN_TIMEOUT),
            ExitShutdownOutcome::Cancelled
        );
        assert_eq!(
            hooks.events,
            vec![
                "request_drain",
                "wait_reader",
                "join_reader",
                "wait_drain",
                "cancel_pump",
                "wait_worker",
                "join_worker",
                "remove_session",
            ]
        );
    }

    #[test]
    fn timeout_cancels_pump_wakes_blocked_producer_and_records_once() {
        let clock = TestClock::new();
        let pump = test_pump(
            "timeout",
            PumpLimits {
                max_pending_bytes: 1,
                max_pending_fragments: 1,
                max_batch_bytes: 1,
                max_in_flight: 1,
                visible_cadence: Duration::ZERO,
                hidden_cadence: Duration::ZERO,
                exit_drain_timeout: EXIT_DRAIN_TIMEOUT,
            },
            Arc::clone(&clock),
        );
        pump.enqueue(vec![1]).unwrap();
        assert_eq!(
            pump.emit_ready(|_| Ok(())),
            Ok(EmitOutcome::Emitted { sequence: 1 })
        );
        pump.enqueue(vec![2]).unwrap();
        let producer_pump = pump.clone();
        let producer = thread::spawn(move || producer_pump.enqueue(vec![3]));
        wait_for_blocked_producers(&pump, 1);
        let mut hooks = BlockingProducerTimeoutHooks {
            clock: Arc::clone(&clock),
            pump: pump.clone(),
            session_present: true,
        };

        assert_eq!(
            coordinate_exit_shutdown(&mut hooks, EXIT_DRAIN_TIMEOUT),
            ExitShutdownOutcome::TimedOut
        );
        assert_eq!(
            producer.join().unwrap(),
            Err(EnqueueError::Cancelled { fragment: vec![3] })
        );
        let snapshot = pump.snapshot();
        assert!(snapshot.cancelled);
        assert_eq!(snapshot.blocked_producers, 0);
        assert_eq!(snapshot.metrics.drain_timeout_count, 1);
        assert_eq!(
            clock.sample().instant.duration_since(clock.origin),
            EXIT_DRAIN_TIMEOUT
        );
    }

    #[test]
    fn acknowledgement_wakes_backpressured_producer_and_records_latency() {
        let clock = TestClock::new();
        let pump = test_pump(
            "ack",
            PumpLimits {
                max_pending_bytes: 1,
                max_pending_fragments: 1,
                max_batch_bytes: 1,
                max_in_flight: 1,
                visible_cadence: Duration::ZERO,
                hidden_cadence: Duration::ZERO,
                exit_drain_timeout: EXIT_DRAIN_TIMEOUT,
            },
            Arc::clone(&clock),
        );
        let (events_tx, events_rx) = mpsc::channel();
        pump.start_worker(move |event| {
            events_tx.send(event.clone()).unwrap();
            Ok(())
        })
        .unwrap();

        pump.enqueue(vec![1]).unwrap();
        let first = events_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(first.sequence, 1);

        pump.enqueue(vec![2]).unwrap();
        let producer_pump = pump.clone();
        let producer = thread::spawn(move || producer_pump.enqueue(vec![3]));
        wait_for_blocked_producers(&pump, 1);

        clock.advance(Duration::from_millis(9));
        assert!(matches!(
            pump.acknowledge(1).unwrap(),
            AckOutcome::Advanced {
                sequence: 1,
                latency,
                ..
            } if latency == Duration::from_millis(9)
        ));

        let second = events_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!((second.sequence, second.bytes), (2, vec![2]));
        producer.join().unwrap().unwrap();
        let snapshot = pump.snapshot();
        assert_eq!(snapshot.metrics.state.batches_acknowledged, 1);
        assert_eq!(
            snapshot.metrics.state.total_ack_latency,
            Duration::from_millis(9)
        );
        assert_eq!(
            snapshot.metrics.state.max_ack_latency,
            Duration::from_millis(9)
        );

        pump.cancel_and_join().unwrap();
    }

    #[test]
    fn cancellation_wakes_blocked_producers_and_worker_without_leaking_threads() {
        let clock = TestClock::new();
        let pump = test_pump(
            "cancel",
            PumpLimits {
                max_pending_bytes: 1,
                max_pending_fragments: 1,
                max_batch_bytes: 1,
                max_in_flight: 1,
                visible_cadence: Duration::ZERO,
                hidden_cadence: Duration::ZERO,
                exit_drain_timeout: EXIT_DRAIN_TIMEOUT,
            },
            clock,
        );

        pump.enqueue(vec![1]).unwrap();
        assert_eq!(
            pump.emit_ready(|_| Ok(())),
            Ok(EmitOutcome::Emitted { sequence: 1 })
        );
        pump.enqueue(vec![2]).unwrap();
        let producer_pump = pump.clone();
        let producer = thread::spawn(move || producer_pump.enqueue(vec![3]));
        wait_for_blocked_producers(&pump, 1);

        pump.start_worker(|_| Ok(())).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while !pump.snapshot().worker_running {
            assert!(Instant::now() < deadline, "pump worker did not start");
            thread::yield_now();
        }

        pump.cancel_and_join().unwrap();
        assert_eq!(
            producer.join().unwrap(),
            Err(EnqueueError::Cancelled { fragment: vec![3] })
        );
        let cancelled = pump.snapshot();
        assert!(cancelled.cancelled);
        assert!(!cancelled.worker_running);
        assert_eq!(cancelled.blocked_producers, 0);
    }

    #[test]
    fn randomized_fragment_order_is_exact_through_enqueue_emit_and_ack() {
        let clock = TestClock::new();
        let pump = test_pump(
            "ordering",
            PumpLimits {
                max_pending_bytes: 1024,
                max_pending_fragments: 128,
                max_batch_bytes: 17,
                max_in_flight: 2,
                visible_cadence: Duration::ZERO,
                hidden_cadence: Duration::ZERO,
                exit_drain_timeout: EXIT_DRAIN_TIMEOUT,
            },
            clock,
        );
        let mut seed = 0x7a5b_319d_u64;
        let mut expected = Vec::new();
        for fragment_index in 0..73_u8 {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let length = (seed as usize % 13) + 1;
            let fragment = (0..length)
                .map(|byte_index| fragment_index.wrapping_add(byte_index as u8))
                .collect::<Vec<_>>();
            expected.extend_from_slice(&fragment);
            pump.enqueue(fragment).unwrap();
        }

        let mut emitted = Vec::new();
        let mut next_sequence = 1;
        while !pump.snapshot().is_empty() {
            assert_eq!(
                pump.emit_ready(|event| {
                    emitted.extend_from_slice(&event.bytes);
                    Ok(())
                }),
                Ok(EmitOutcome::Emitted {
                    sequence: next_sequence
                })
            );
            pump.acknowledge(next_sequence).unwrap();
            next_sequence += 1;
        }

        assert_eq!(emitted, expected);
        assert_eq!(
            pump.snapshot().metrics.state.bytes_acknowledged,
            expected.len() as u64
        );
    }

    #[test]
    fn batch_event_metadata_is_exact_and_sequences_are_monotonic() {
        let clock = TestClock::new();
        let pump = test_pump(
            "metadata-thread",
            PumpLimits {
                max_pending_bytes: 16,
                max_pending_fragments: 4,
                max_batch_bytes: 4,
                max_in_flight: 1,
                visible_cadence: Duration::ZERO,
                hidden_cadence: Duration::ZERO,
                exit_drain_timeout: EXIT_DRAIN_TIMEOUT,
            },
            Arc::clone(&clock),
        );

        clock.advance(Duration::from_micros(11));
        pump.enqueue(b"ab".to_vec()).unwrap();
        clock.advance(Duration::from_micros(2));
        pump.enqueue(b"cdef".to_vec()).unwrap();
        clock.advance(Duration::from_micros(16));

        let mut first = None;
        assert_eq!(
            pump.emit_ready(|event| {
                first = Some(event.clone());
                Ok(())
            }),
            Ok(EmitOutcome::Emitted { sequence: 1 })
        );
        let first = first.unwrap();
        assert_eq!(first.thread_id, "metadata-thread");
        assert_eq!(first.sequence, 1);
        assert_eq!(first.bytes, b"abcd");
        assert_eq!(first.byte_count, 4);
        assert_eq!(first.enqueued_at_micros, 11);
        assert_eq!(first.emitted_at_micros, 29);
        assert_eq!(first.queued_bytes, 2);
        assert_eq!(first.queue_depth, 1);

        pump.acknowledge(1).unwrap();
        let mut second = None;
        assert_eq!(
            pump.emit_ready(|event| {
                second = Some(event.clone());
                Ok(())
            }),
            Ok(EmitOutcome::Emitted { sequence: 2 })
        );
        let second = second.unwrap();
        assert_eq!(second.sequence, 2);
        assert_eq!(second.bytes, b"ef");
        assert_eq!(second.byte_count, 2);
        assert_eq!(second.enqueued_at_micros, 13);
        assert_eq!(second.emitted_at_micros, 29);
        assert_eq!(second.queued_bytes, 0);
        assert_eq!(second.queue_depth, 0);
    }
}
