export const SLACK_PERSON_IDENTIFIER_PREFIX = "slack";

export function buildNormalizedSlackPersonIdentifier(params: {
  teamId: string;
  userId: string;
}): string | null {
  const teamId = params.teamId.trim().toLowerCase();
  const userId = params.userId.trim().toLowerCase();
  if (!teamId || !userId) return null;
  return `${SLACK_PERSON_IDENTIFIER_PREFIX}:${teamId}:${userId}`;
}

export function parseSlackPersonIdentifier(
  value: string
): { teamId: string; userId: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const segments = trimmed.split(":");
  if (segments.length !== 3) return null;
  const [prefix, teamId, userId] = segments;
  if (prefix.trim().toLowerCase() !== SLACK_PERSON_IDENTIFIER_PREFIX) return null;
  const normalizedTeamId = teamId.trim();
  const normalizedUserId = userId.trim();
  if (!normalizedTeamId || !normalizedUserId) return null;
  return { teamId: normalizedTeamId, userId: normalizedUserId };
}
