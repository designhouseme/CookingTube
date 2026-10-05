/**
 * Video moments travel between the app and the model as player clock strings ("2:05", "12:30", "1:02:05").
 * Gemini reads video with M:SS markers, so asking it for plain seconds made it write 1:25 as 125 in some
 * answers and as 85 in others. A clock string is unambiguous; a bare number, "2.05" or "2:75" is rejected.
 */
export function parseMoment(value: string | null | undefined): number | null {
  const match = value?.trim().match(/^(?:(\d{1,2}):([0-5]\d)|(\d{1,3})):([0-5]\d)(?:\.\d+)?$/);
  if (!match) return null;
  const [, hours, hourMinutes, minutes, seconds] = match;
  return hours !== undefined ? Number(hours) * 3600 + Number(hourMinutes) * 60 + Number(seconds) : Number(minutes) * 60 + Number(seconds);
}

export function momentClock(total: number) {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), rest = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}
