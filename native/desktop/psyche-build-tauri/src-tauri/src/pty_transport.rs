use std::collections::VecDeque;
use std::error::Error;
use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const MAX_PENDING_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PENDING_FRAGMENTS: usize = 128;
pub const MAX_BATCH_BYTES: usize = 64 * 1024;
pub const MAX_IN_FLIGHT: usize = 2;
pub const VISIBLE_CADENCE: Duration = Duration::from_millis(16);
pub const HIDDEN_CADENCE: Duration = Duration::from_millis(100);
pub const EXIT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

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
}

impl PendingFragment {
    fn new(data: Vec<u8>) -> Self {
        Self {
            data,
            consumed_bytes: 0,
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
        self.pending.push_back(PendingFragment::new(fragment));
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
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::*;

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
}
