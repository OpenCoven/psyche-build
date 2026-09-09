//! Which PTY sessions exist, and what state each one is in.
//!
//! #197 slice 3 gives the lifecycle registry its own module. Every pane's PTY
//! is installed here, looked up here, and removed here, and the generation
//! counter that makes a stale operation detectable lives here too.
//!
//! The registry is generic over its session type so its state machine can be
//! tested without a real PTY. `PTY_LIFECYCLES` is the one instantiation the
//! application uses.
//!
//! **Two neighbours deliberately stayed in the crate root.**
//! `finish_pty_lifecycle` is lifecycle bookkeeping, but it takes a
//! `&PtyExitShutdown` from `pty_reader`, which already imports this registry;
//! moving it would make the two modules import each other. `terminate_pty_session`
//! consumes a `PtySession` and drives `pty_process`, so it belongs to neither
//! side cleanly. Both are seams between capabilities rather than members of
//! one, and the crate root is where a seam belongs until something better
//! exists.

use super::*;

pub(crate) struct PtySession {
    pub(crate) master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub(crate) writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub(crate) operation_lane: Arc<tokio::sync::Mutex<()>>,
    pub(crate) operation_admission: Arc<tokio::sync::Semaphore>,
    pub(crate) pump: OutputPump,
    pub(crate) terminator: PtyProcessTerminator,
    pub(crate) reader_cancellation: PtyReaderCancellation,
    pub(crate) pid: Option<u32>,
    pub(crate) spawn_time_unix_secs: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PtySessionToken {
    pub(crate) thread_id: String,
    pub(crate) generation: u64,
}

#[derive(Debug)]
enum PtyLifecycleState<T> {
    Starting { stop_requested: bool },
    Running(T),
    Stopping,
    Exiting,
}

#[derive(Debug)]
struct PtyLifecycleEntry<T> {
    generation: u64,
    state: PtyLifecycleState<T>,
}

#[derive(Debug)]
pub(crate) struct PtyLifecycleRegistry<T> {
    next_generation: u64,
    entries: HashMap<String, PtyLifecycleEntry<T>>,
}

impl<T> Default for PtyLifecycleRegistry<T> {
    fn default() -> Self {
        Self {
            next_generation: 1,
            entries: HashMap::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PtyLifecycleError {
    AlreadyRunning {
        thread_id: String,
    },
    CleanupInProgress {
        thread_id: String,
    },
    GenerationRequired {
        thread_id: String,
    },
    StaleOperation {
        thread_id: String,
        expected: u64,
        actual: u64,
    },
    GenerationExhausted,
    StaleStart {
        thread_id: String,
        generation: u64,
    },
    NotFound {
        thread_id: String,
    },
    AlreadyStopping {
        thread_id: String,
        generation: u64,
    },
}

impl std::fmt::Display for PtyLifecycleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyRunning { thread_id } => {
                write!(formatter, "thread '{thread_id}' already running")
            }
            Self::CleanupInProgress { thread_id } => {
                write!(formatter, "thread '{thread_id}' cleanup in progress")
            }
            Self::GenerationRequired { thread_id } => {
                write!(formatter, "thread '{thread_id}' operation requires a PTY generation")
            }
            Self::StaleOperation {
                thread_id,
                expected,
                actual,
            } => write!(
                formatter,
                "thread '{thread_id}' operation generation {expected} is stale; current generation is {actual}"
            ),
            Self::GenerationExhausted => formatter.write_str("PTY session generation exhausted"),
            Self::StaleStart {
                thread_id,
                generation,
            } => write!(
                formatter,
                "thread '{thread_id}' start generation {generation} is stale"
            ),
            Self::NotFound { thread_id } => write!(formatter, "thread '{thread_id}' not found"),
            Self::AlreadyStopping {
                thread_id,
                generation,
            } => write!(
                formatter,
                "thread '{thread_id}' generation {generation} is already stopping"
            ),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum InstallSessionOutcome<T> {
    Running,
    StopImmediately(T),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StopSessionOutcome<T> {
    RecordedDuringStart { generation: u64 },
    Terminate { generation: u64, session: T },
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BeginExitOutcome<T> {
    Emit { session: Option<T> },
    Stale,
}

impl<T> PtyLifecycleRegistry<T> {
    pub(crate) fn reserve(
        &mut self,
        thread_id: &str,
    ) -> Result<PtySessionToken, PtyLifecycleError> {
        if let Some(entry) = self.entries.get(thread_id) {
            return Err(match entry.state {
                PtyLifecycleState::Exiting => PtyLifecycleError::CleanupInProgress {
                    thread_id: thread_id.to_string(),
                },
                _ => PtyLifecycleError::AlreadyRunning {
                    thread_id: thread_id.to_string(),
                },
            });
        }
        let generation = self.next_generation;
        self.next_generation = self
            .next_generation
            .checked_add(1)
            .ok_or(PtyLifecycleError::GenerationExhausted)?;
        self.entries.insert(
            thread_id.to_string(),
            PtyLifecycleEntry {
                generation,
                state: PtyLifecycleState::Starting {
                    stop_requested: false,
                },
            },
        );
        Ok(PtySessionToken {
            thread_id: thread_id.to_string(),
            generation,
        })
    }

    pub(crate) fn install(
        &mut self,
        token: &PtySessionToken,
        session: T,
    ) -> Result<InstallSessionOutcome<T>, PtyLifecycleError> {
        let entry = self
            .entries
            .get_mut(&token.thread_id)
            .filter(|entry| entry.generation == token.generation)
            .ok_or_else(|| PtyLifecycleError::StaleStart {
                thread_id: token.thread_id.clone(),
                generation: token.generation,
            })?;
        match entry.state {
            PtyLifecycleState::Starting {
                stop_requested: true,
            } => {
                entry.state = PtyLifecycleState::Stopping;
                Ok(InstallSessionOutcome::StopImmediately(session))
            }
            PtyLifecycleState::Starting {
                stop_requested: false,
            } => {
                entry.state = PtyLifecycleState::Running(session);
                Ok(InstallSessionOutcome::Running)
            }
            _ => Err(PtyLifecycleError::StaleStart {
                thread_id: token.thread_id.clone(),
                generation: token.generation,
            }),
        }
    }

    pub(crate) fn stop(
        &mut self,
        thread_id: &str,
        expected_generation: Option<u64>,
    ) -> Result<StopSessionOutcome<T>, PtyLifecycleError> {
        let entry = self
            .entries
            .get_mut(thread_id)
            .ok_or_else(|| PtyLifecycleError::NotFound {
                thread_id: thread_id.to_string(),
            })?;
        if let Some(expected) = expected_generation {
            if expected != entry.generation {
                return Err(PtyLifecycleError::StaleOperation {
                    thread_id: thread_id.to_string(),
                    expected,
                    actual: entry.generation,
                });
            }
        } else if matches!(entry.state, PtyLifecycleState::Running(_)) {
            return Err(PtyLifecycleError::GenerationRequired {
                thread_id: thread_id.to_string(),
            });
        }
        match &mut entry.state {
            PtyLifecycleState::Starting { stop_requested } => {
                *stop_requested = true;
                Ok(StopSessionOutcome::RecordedDuringStart {
                    generation: entry.generation,
                })
            }
            PtyLifecycleState::Running(_) => {
                let state = std::mem::replace(&mut entry.state, PtyLifecycleState::Stopping);
                let PtyLifecycleState::Running(session) = state else {
                    unreachable!("running PTY state was checked before replacement");
                };
                Ok(StopSessionOutcome::Terminate {
                    generation: entry.generation,
                    session,
                })
            }
            PtyLifecycleState::Stopping | PtyLifecycleState::Exiting => {
                Err(PtyLifecycleError::AlreadyStopping {
                    thread_id: thread_id.to_string(),
                    generation: entry.generation,
                })
            }
        }
    }

    pub(crate) fn begin_exit(&mut self, token: &PtySessionToken) -> BeginExitOutcome<T> {
        let Some(entry) = self
            .entries
            .get_mut(&token.thread_id)
            .filter(|entry| entry.generation == token.generation)
        else {
            return BeginExitOutcome::Stale;
        };
        match entry.state {
            PtyLifecycleState::Running(_) => {
                let state = std::mem::replace(&mut entry.state, PtyLifecycleState::Exiting);
                let PtyLifecycleState::Running(session) = state else {
                    unreachable!("running PTY state was checked before replacement");
                };
                BeginExitOutcome::Emit {
                    session: Some(session),
                }
            }
            PtyLifecycleState::Stopping => {
                entry.state = PtyLifecycleState::Exiting;
                BeginExitOutcome::Emit { session: None }
            }
            PtyLifecycleState::Starting { .. } | PtyLifecycleState::Exiting => {
                BeginExitOutcome::Stale
            }
        }
    }

    pub(crate) fn finish_exit(&mut self, token: &PtySessionToken) -> bool {
        let should_remove = self.entries.get(&token.thread_id).is_some_and(|entry| {
            entry.generation == token.generation
                && matches!(entry.state, PtyLifecycleState::Exiting)
        });
        if should_remove {
            self.entries.remove(&token.thread_id);
        }
        should_remove
    }

    pub(crate) fn abort_start(&mut self, token: &PtySessionToken) -> bool {
        let should_remove = self.entries.get(&token.thread_id).is_some_and(|entry| {
            entry.generation == token.generation
                && matches!(entry.state, PtyLifecycleState::Starting { .. })
        });
        if should_remove {
            self.entries.remove(&token.thread_id);
        }
        should_remove
    }

    pub(crate) fn live(&self, thread_id: &str) -> Option<&T> {
        self.entries
            .get(thread_id)
            .and_then(|entry| match &entry.state {
                PtyLifecycleState::Running(session) => Some(session),
                _ => None,
            })
    }

    pub(crate) fn current_generation(&self, thread_id: &str) -> Option<u64> {
        self.entries.get(thread_id).map(|entry| entry.generation)
    }

    pub(crate) fn live_with_generation(
        &self,
        thread_id: &str,
        expected_generation: Option<u64>,
    ) -> Result<&T, PtyLifecycleError> {
        let entry = self
            .entries
            .get(thread_id)
            .ok_or_else(|| PtyLifecycleError::NotFound {
                thread_id: thread_id.to_string(),
            })?;
        if let Some(expected) = expected_generation {
            if expected != entry.generation {
                return Err(PtyLifecycleError::StaleOperation {
                    thread_id: thread_id.to_string(),
                    expected,
                    actual: entry.generation,
                });
            }
        } else if matches!(entry.state, PtyLifecycleState::Running(_)) {
            return Err(PtyLifecycleError::GenerationRequired {
                thread_id: thread_id.to_string(),
            });
        }
        match &entry.state {
            PtyLifecycleState::Running(session) => Ok(session),
            _ => Err(PtyLifecycleError::NotFound {
                thread_id: thread_id.to_string(),
            }),
        }
    }

    #[cfg(test)]
    fn is_live(&self, thread_id: &str) -> bool {
        self.live(thread_id).is_some()
    }

    pub(crate) fn live_sessions(&self) -> Vec<(&String, &T)> {
        self.entries
            .iter()
            .filter_map(|(thread_id, entry)| match &entry.state {
                PtyLifecycleState::Running(session) => Some((thread_id, session)),
                _ => None,
            })
            .collect()
    }

    pub(crate) fn live_thread_ids(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter_map(|(thread_id, entry)| {
                matches!(entry.state, PtyLifecycleState::Running(_)).then(|| thread_id.clone())
            })
            .collect()
    }
}

pub(crate) static PTY_LIFECYCLES: Lazy<Mutex<PtyLifecycleRegistry<PtySession>>> =
    Lazy::new(|| Mutex::new(PtyLifecycleRegistry::default()));

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::sync::Arc;

    use super::*;

    #[test]
    fn stop_during_start_is_recorded_and_installed_session_is_stopped() {
        let mut registry = PtyLifecycleRegistry::default();
        let start = registry.reserve("racing-start").unwrap();

        assert_eq!(
            registry
                .stop("racing-start", Some(start.generation))
                .unwrap(),
            StopSessionOutcome::RecordedDuringStart {
                generation: start.generation,
            }
        );
        assert_eq!(
            registry.install(&start, "spawned-child").unwrap(),
            InstallSessionOutcome::StopImmediately("spawned-child")
        );
        assert!(!registry.is_live("racing-start"));
        assert!(registry.reserve("racing-start").is_err());
        assert!(matches!(
            registry.begin_exit(&start),
            BeginExitOutcome::Emit { session: None }
        ));
        assert!(registry.finish_exit(&start));
    }

    #[test]
    fn same_id_restart_waits_for_exit_and_old_generation_cannot_emit_again() {
        let mut registry = PtyLifecycleRegistry::default();
        let old = registry.reserve("same-id").unwrap();
        assert_eq!(
            registry.install(&old, "old-session").unwrap(),
            InstallSessionOutcome::Running
        );
        assert_eq!(
            registry.stop("same-id", Some(old.generation)).unwrap(),
            StopSessionOutcome::Terminate {
                generation: old.generation,
                session: "old-session",
            }
        );
        assert!(matches!(
            registry.begin_exit(&old),
            BeginExitOutcome::Emit { session: None }
        ));
        assert!(registry.reserve("same-id").is_err());

        assert!(registry.finish_exit(&old));
        let replacement = registry.reserve("same-id").unwrap();
        assert_ne!(replacement.generation, old.generation);
        assert!(matches!(registry.begin_exit(&old), BeginExitOutcome::Stale));
        assert_eq!(
            registry
                .install(&replacement, "replacement-session")
                .unwrap(),
            InstallSessionOutcome::Running
        );
        assert!(registry.is_live("same-id"));
    }

    #[test]
    fn timed_out_exit_blocks_same_id_restart_until_old_emitter_cleanup_finishes() {
        let registry = Arc::new(Mutex::new(PtyLifecycleRegistry::default()));
        let old = {
            let mut registry = registry.lock();
            let old = registry.reserve("timed-out-pane").unwrap();
            assert_eq!(
                registry.install(&old, "old-output-pump").unwrap(),
                InstallSessionOutcome::Running
            );
            assert_eq!(
                registry.reserve("timed-out-pane").unwrap_err().to_string(),
                "thread 'timed-out-pane' already running"
            );
            assert!(matches!(
                registry.begin_exit(&old),
                BeginExitOutcome::Emit {
                    session: Some("old-output-pump")
                }
            ));
            old
        };
        let (old_emit_done_tx, old_emit_done_rx) = mpsc::channel();
        let cleanup_registry = Arc::clone(&registry);
        let cleanup_token = old.clone();
        let cleanup = std::thread::spawn(move || {
            old_emit_done_rx.recv().unwrap();
            cleanup_registry.lock().finish_exit(&cleanup_token)
        });
        assert_eq!(
            registry
                .lock()
                .reserve("timed-out-pane")
                .unwrap_err()
                .to_string(),
            "thread 'timed-out-pane' cleanup in progress"
        );
        old_emit_done_tx.send(()).unwrap();
        assert!(cleanup.join().unwrap());
        let replacement = registry.lock().reserve("timed-out-pane").unwrap();
        assert_ne!(replacement.generation, old.generation);
    }
}
