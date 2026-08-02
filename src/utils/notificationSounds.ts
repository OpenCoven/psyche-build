export const NOTIFICATION_SOUND_IDS = [
  'default-system-sound',
  'braam',
  'brass',
  'ding-bell',
  'future',
  'harp',
  'quiet-bells',
  'sonar',
  'success',
  'triumphant-trumpet',
  'war-horn',
] as const;

export type NotificationSoundId = typeof NOTIFICATION_SOUND_IDS[number];

export interface NotificationSoundDefinition {
  id: NotificationSoundId;
  label: string;
  resourceFileName?: string;
  defaultEnabled: boolean;
}

export const NOTIFICATION_SOUND_DEFINITIONS: readonly NotificationSoundDefinition[] = [
  {
    id: 'default-system-sound',
    label: 'Default System Sound',
    defaultEnabled: true,
  },
  {
    id: 'braam',
    label: 'Braam',
    resourceFileName: 'psyche-braam.caf',
    defaultEnabled: false,
  },
  {
    id: 'brass',
    label: 'Brass',
    resourceFileName: 'psyche-brass.caf',
    defaultEnabled: false,
  },
  {
    id: 'ding-bell',
    label: 'Ding Bell',
    resourceFileName: 'psyche-ding-bell.caf',
    defaultEnabled: false,
  },
  {
    id: 'future',
    label: 'Future',
    resourceFileName: 'psyche-future.caf',
    defaultEnabled: false,
  },
  {
    id: 'harp',
    label: 'Harp',
    resourceFileName: 'psyche-harp.caf',
    defaultEnabled: false,
  },
  {
    id: 'quiet-bells',
    label: 'Quiet Bells',
    resourceFileName: 'psyche-quiet-bells.caf',
    defaultEnabled: false,
  },
  {
    id: 'sonar',
    label: 'Sonar',
    resourceFileName: 'psyche-sonar.caf',
    defaultEnabled: false,
  },
  {
    id: 'success',
    label: 'Success',
    resourceFileName: 'psyche-success.caf',
    defaultEnabled: false,
  },
  {
    id: 'triumphant-trumpet',
    label: 'Triumphant Trumpet',
    resourceFileName: 'psyche-triumphant-trumpet.caf',
    defaultEnabled: false,
  },
  {
    id: 'war-horn',
    label: 'War Horn',
    resourceFileName: 'psyche-war-horn.caf',
    defaultEnabled: false,
  },
] as const;

const NOTIFICATION_SOUND_ID_SET = new Set<string>(
  NOTIFICATION_SOUND_DEFINITIONS.map((definition) => definition.id)
);

export function getNotificationSoundDefinitions(): NotificationSoundDefinition[] {
  return NOTIFICATION_SOUND_DEFINITIONS.map((definition) => ({ ...definition }));
}

export function getBundledNotificationSoundDefinitions(): NotificationSoundDefinition[] {
  return NOTIFICATION_SOUND_DEFINITIONS
    .filter((definition) => typeof definition.resourceFileName === 'string')
    .map((definition) => ({ ...definition }));
}

export function getDefaultNotificationSoundSelection(): NotificationSoundId[] {
  return NOTIFICATION_SOUND_DEFINITIONS
    .filter((definition) => definition.defaultEnabled)
    .map((definition) => definition.id);
}

export function isNotificationSoundId(value: string): value is NotificationSoundId {
  return NOTIFICATION_SOUND_ID_SET.has(value);
}

export function resolveNotificationSoundsSelection(
  enabledNotificationSounds: readonly string[] | undefined
): NotificationSoundId[] {
  if (Array.isArray(enabledNotificationSounds)) {
    const configured = new Set(enabledNotificationSounds.filter(isNotificationSoundId));
    const resolved = NOTIFICATION_SOUND_DEFINITIONS
      .map((definition) => definition.id)
      .filter((id) => configured.has(id));

    if (resolved.length > 0) {
      return resolved;
    }
  }

  return getDefaultNotificationSoundSelection();
}

export function getNotificationSoundDefinition(
  id: NotificationSoundId
): NotificationSoundDefinition {
  const definition = NOTIFICATION_SOUND_DEFINITIONS.find((candidate) => candidate.id === id);
  if (!definition) {
    throw new Error(`Unknown notification sound: ${id}`);
  }

  return { ...definition };
}

export function pickNotificationSound(
  enabledNotificationSounds: readonly string[] | undefined,
  randomValue: number = Math.random()
): NotificationSoundDefinition {
  const selection = resolveNotificationSoundsSelection(enabledNotificationSounds);
  const boundedRandomValue = Math.max(0, Math.min(0.999999999, randomValue));
  const index = Math.floor(boundedRandomValue * selection.length);
  return getNotificationSoundDefinition(selection[index] ?? selection[0]);
}
