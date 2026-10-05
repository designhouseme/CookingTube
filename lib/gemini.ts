import { formatVideoRecipe, videoRecipeInstructions, videoRecipeSchema } from "./recipe-format.ts";
import { limitedText } from "./video.ts";
import { assessVideo, assessmentInstructions, assessmentSchema } from "./video-assessment.ts";
import { momentClock } from "./video-moment.ts";
import { youtubeLength } from "./youtube-length.ts";

import type { AppLocale } from "./locale.ts";

export class GeminiError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

// The only model the app uses; it is not configurable through the environment.
export const GEMINI_MODEL = "gemini-3.8-flash";

export function geminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new GeminiError("Przygotowywanie przepisów jest chwilowo niedostępne. Spróbuj ponownie później.", 503);
  return { apiKey, model: GEMINI_MODEL };
}

type Interaction = { status?: string; steps?: { type: string; content?: { type: string; text?: string }[] }[] };
export function readGeminiOutput(data: Interaction): string {
  if (data.status !== "completed") throw new GeminiError("Nie udało się dokończyć przepisu. Spróbuj ponownie.");
  const output = data.steps?.filter(step => step.type === "model_output").flatMap(step => step.content ?? [])
    .filter(part => part.type === "text").map(part => part.text ?? "").join("");
  if (!output?.trim()) throw new GeminiError("Nie znaleźliśmy treści potrzebnej do przygotowania przepisu. Wybierz inny film.", 422);
  return output;
}

export async function generateRecipe(id: string, signal?: AbortSignal, locale: AppLocale = "pl") {
  if (!/^[\w-]{11}$/.test(id)) throw new GeminiError("Wklej prawidłowy link do filmu z YouTube.", 400);
  const timeout = AbortSignal.timeout(120_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  // The real length comes from YouTube in parallel; it checks the model's timeline.
  const [verdict, realLength] = await Promise.all([videoInteraction(id, assessmentInstructions, assessmentSchema, 1800, combined), youtubeLength(id, combined)]);
  const assessment = assessVideo(verdict, realLength);
  const localized = locale === "pl" ? videoRecipeInstructions : videoRecipeInstructions.replace(/PO POLSKU/gi, "po angielsku").replace(/polskie nazwy/g, "angielskie nazwy") + "\nAll user-facing recipe content MUST be in English: title, description, ingredients, amounts, steps and notes. Keep evidence in the original language.";
  // With the real length the model can check its own moments against the end of the video.
  const instructions = realLength ? `${localized}\nFilm trwa ${momentClock(realLength)}. Każdy moment at musi być wcześniejszy.` : localized;
  const output = await videoInteraction(id, instructions, videoRecipeSchema, 6000, combined);
  return { ...formatVideoRecipe(output, id, assessment.durationSeconds ?? undefined, assessment.timelineTrusted), language: locale };
}

async function videoInteraction(id: string, instructions: string, schema: object, maxTokens: number, signal: AbortSignal) {
  const { apiKey, model } = geminiConfig();
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST", redirect: "manual",
    signal,
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      model, input: [
        { type: "video", uri: `https://www.youtube.com/watch?v=${id}` },
        { type: "text", text: "Przeanalizuj ten film zgodnie z instrukcjami. Zwróć wynik w jednym JSON." },
      ], system_instruction: instructions, store: false,
      generation_config: { max_output_tokens: maxTokens, thinking_level: "low", thinking_summaries: "none" },
      response_format: { type: "text", mime_type: "application/json", schema },
    }),
  });
  if (!response.ok) {
    // Never return provider bodies or request headers: they may contain credential details.
    await response.body?.cancel();
    if (response.status === 429) throw new GeminiError("Wykorzystaliśmy chwilowy limit przygotowywania przepisów. Spróbuj ponownie później.", 429);
    if (response.status === 400) throw new GeminiError("Nie udało się odczytać tego filmu. Wybierz publiczny film z jednym przepisem, dostępny bez logowania.", 422);
    if ([401, 403, 404].includes(response.status)) throw new GeminiError("Przygotowywanie przepisów jest chwilowo niedostępne. Spróbuj ponownie później.", 503);
    if (response.status === 503) throw new GeminiError("Przygotowywanie przepisów jest teraz przeciążone. Spróbuj ponownie za chwilę.", 503);
    throw new GeminiError("Nie udało się teraz przygotować przepisu. Spróbuj ponownie za chwilę.");
  }
  const data = JSON.parse(await limitedText(response, 200_000)) as Interaction;
  return readGeminiOutput(data);
}
