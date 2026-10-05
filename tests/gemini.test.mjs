import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRecipe, readGeminiOutput } from '../lib/gemini.ts';
import { formatVideoRecipe } from '../lib/recipe-format.ts';
import { recipeResultSchema } from '../lib/recipe.ts';
import { POST } from '../app/api/recipe/route.ts';
process.env.YOUTUBE_LENGTH_LOOKUP = 'off'; // These tests mock the Gemini calls only.

process.env.GEMINI_API_KEY = 'test-only-key';
const output = { isRecipe: true, title: 'Makaron', description: 'Makaron z cytryną.',
  servings: null, servingsEvidence: '', time: '15 minut', timeEvidence: '',
  ingredients: [{ name: 'makaron', amount: '200 g', evidence: '200 grams of pasta' }, { name: 'cytryna', amount: '2 sztuki', evidence: '' }],
  steps: [{ title: 'Połącz składniki', description: 'Dodaj sok z cytryny do makaronu.', at: '0:42', atEvidence: 'Autor wyciska cytrynę do makaronu.' }], notes: [] };
const interaction = value => ({ status: 'completed', steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text: JSON.stringify(value) }] }] });
const accepted = { category: 'cooking', hasIngredients: true, hasPreparation: true, confidence: 0.97, duration: '3:00', observations: [{ at: '0:12', evidence: 'Autor gotuje makaron w garnku.' }, { at: '0:42', evidence: 'Autor dodaje cytrynę do makaronu.' }] };
const responseFor = init => Response.json(interaction(JSON.parse(init.body).response_format.schema.properties.category ? accepted : output));
const request = (url, options = {}) => new Request('https://cooking-tube.example/api/recipe', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://cooking-tube.example', 'Accept-Language': 'pl-PL' }, body: JSON.stringify({ url }), ...options,
});

test('sends the canonical public video directly to Gemini with server-only authentication', async t => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(init.headers['x-goog-api-key'], 'test-only-key');
    assert.equal(init.redirect, 'manual');
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    assert.equal(body.model, 'gemini-3.8-flash');
    assert.deepEqual(body.input[0], { type: 'video', uri: 'https://www.youtube.com/watch?v=SwDJi_PB-wY' });
    assert.equal(body.response_format.mime_type, 'application/json');
    assert.equal(init.body.includes('test-only-key'), false);
    return responseFor(init);
  });
  const recipe = await generateRecipe('SwDJi_PB-wY');
  assert.equal(recipeResultSchema.safeParse(recipe).success, true);
  assert.equal(recipe.ingredients[0].amount, '200 g');
  assert.equal(recipe.ingredients[1].amount, null);
  assert.equal(recipe.time, null);
  assert.equal(recipe.steps[0].at, 42);
});

test('rejects unsafe video IDs before contacting a provider', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  await assert.rejects(generateRecipe('../../secret'), { status: 400 });
  assert.equal(fetch.mock.callCount(), 0);
});

test('does not turn incomplete output or non-recipe videos into a recipe', () => {
  assert.throws(() => readGeminiOutput({ status: 'in_progress', steps: interaction(output).steps }));
  assert.throws(() => readGeminiOutput({ status: 'completed', steps: [{ type: 'thought' }] }));
  assert.throws(() => formatVideoRecipe(JSON.stringify({ ...output, isRecipe: false }), 'SwDJi_PB-wY'), /Nie znaleźliśmy/);
  assert.throws(() => formatVideoRecipe('not JSON', 'SwDJi_PB-wY'));
});

test('normalizes links and reuses completed recipes without another provider call', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, init) => responseFor(init));
  const response = await POST(request('https://youtu.be/testvideo01?si=tracking'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).recipe.sourceUrl, 'https://www.youtube.com/watch?v=testvideo01');
  assert.equal((await POST(request('https://www.youtube.com/watch?v=testvideo01'))).status, 200);
  assert.equal(fetch.mock.callCount(), 2);
});

test('rejects cross-origin, malformed, oversized and non-YouTube requests', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  assert.equal((await POST(request('https://youtube.com/watch?v=SwDJi_PB-wY', { headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' } }))).status, 403);
  assert.equal((await POST(request('https://127.0.0.1/private'))).status, 400);
  assert.equal((await POST(request('', { body: '{broken' }))).status, 400);
  assert.equal((await POST(request('x'.repeat(5000)))).status, 400);
  assert.equal((await POST(request('', { headers: { 'Content-Type': 'text/plain' } }))).status, 400);
  assert.equal(fetch.mock.callCount(), 0);
});

test('returns friendly provider errors without exposing provider bodies or credentials', async t => {
  for (const [upstream, expected] of [[400, 422], [401, 503], [403, 503], [429, 429], [503, 503], [500, 502]]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('debug test-only-key upstream internal detail', { status: upstream }));
    const response = await POST(request('https://youtu.be/testvideo02'));
    assert.equal(response.status, expected);
    const body = await response.text();
    assert.doesNotMatch(body, /test-only-key|upstream|internal detail/);
    if (expected === 429) assert.equal(response.headers.get('Retry-After'), '60');
    fetch.mock.restore();
  }
});

test('validates the browser origin against the public Host rather than an internal Next hostname', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', Host: '127.0.0.1:5173', Origin: 'http://127.0.0.1:5173', 'Accept-Language': 'pl-PL' }, body: '{"url":"invalid"}' };
  const response = await POST(new Request('http://localhost:5173/api/recipe', options));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'Wklej prawidłowy link do filmu z YouTube.');
  options.headers.Origin = 'http://other.example';
  assert.equal((await POST(new Request('http://localhost:5173/api/recipe', options))).status, 403);
  assert.equal(fetch.mock.callCount(), 0);
});

test('passes cancellation through to Gemini', async t => {
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    assert.equal(signal.aborted, true);
    throw signal.reason;
  });
  await assert.rejects(generateRecipe('SwDJi_PB-wY', controller.signal), { name: 'AbortError' });
});

test('bounds concurrent provider work and releases slots after failures', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 2) ready();
    await gate;
    return new Response('', { status: 503 });
  });
  const pending = [POST(request('https://youtu.be/testvideo03')), POST(request('https://youtu.be/testvideo04'))];
  await started;
  assert.equal((await POST(request('https://youtu.be/testvideo05'))).status, 429);
  release();
  assert.deepEqual((await Promise.all(pending)).map(r => r.status), [503, 503]);
  assert.equal((await POST(request('https://youtu.be/testvideo05'))).status, 503);
});


test('rejects non-cooking, uncertain and incomplete videos before recipe generation', async t => {
  for (const assessment of [
    { ...accepted, category: 'non_cooking' },
    { ...accepted, category: 'unsafe' },
    { ...accepted, hasPreparation: false },
    { ...accepted, confidence: 0.6 },
    { ...accepted, observations: [] },
    { ...accepted, duration: '1:01:40' },
  ]) {
    const provider = t.mock.method(globalThis, 'fetch', async () => Response.json(interaction(assessment)));
    const response = await POST(request('https://youtu.be/rejected001'));
    assert.equal(response.status, 422);
    assert.equal(provider.mock.callCount(), 1, 'rejected video must never reach recipe generation');
    provider.mock.restore();
  }
});

test('keeps only chronological, evidenced timestamps inside the video duration', () => {
  const steps = [
    { title: 'Start', description: 'Rozpocznij.', at: '0:00', atEvidence: 'Autor pokazuje przygotowanie składników.' },
    { title: 'Gotuj', description: 'Gotuj.', at: '0:42.9', atEvidence: 'Autor wkłada makaron do gotującej wody.' },
    { title: 'Błędny', description: 'Cofnięty znacznik.', at: '0:12', atEvidence: 'Opis widocznej czynności w kuchni.' },
    { title: 'Bez dowodu', description: 'Brak obserwacji.', at: '1:10', atEvidence: '' },
  ];
  const recipe = formatVideoRecipe(JSON.stringify({ ...output, steps }), 'SwDJi_PB-wY', 180);
  assert.deepEqual(recipe.steps.map(step => step.at), [0, 42, null, null]);
  // One moment past the end shows the timeline is invented, so every timestamp is dropped.
  const past = formatVideoRecipe(JSON.stringify({ ...output, steps: [...steps, { title: 'Po filmie', description: 'Poza zakresem.', at: '3:00', atEvidence: 'Opis widocznej czynności w kuchni.' }] }), 'SwDJi_PB-wY', 180);
  assert.ok(past.steps.every(step => step.at === null));
  const untrusted = formatVideoRecipe(JSON.stringify({ ...output, steps }), 'SwDJi_PB-wY', 180, false);
  assert.ok(untrusted.steps.every(step => step.at === null));
});

test('English locale instructs generation in English and is isolated from the Polish cache', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (body.response_format.schema.properties.category) return Response.json(interaction(accepted));
    assert.match(body.system_instruction, /MUST be in English/);
    assert.doesNotMatch(body.system_instruction, /po polsku/i);
    return Response.json(interaction({ ...output, title: 'Pasta with lemon' }));
  });
  const response = await POST(request('https://youtu.be/testvideo01', { headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en-US' } }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.recipe.language, 'en');
  assert.equal(data.recipe.title, 'Pasta with lemon');
  assert.equal(calls, 2);
});

test('keeps a cooking video with an invented timeline but distrusts its timestamps', async () => {
  const { assessVideo } = await import('../lib/video-assessment.ts');
  // The real case: a 196 s cake video with observations at 207 s and 244 s.
  const observations = [{ at: '1:40', evidence: 'Wbijanie jajek do miski i miksowanie z cukrem.' }, { at: '4:04', evidence: 'Wlewanie ciasta do formy keksowej.' }];
  assert.deepEqual(assessVideo(JSON.stringify({ ...accepted, duration: '3:16', observations }), 196), { durationSeconds: 196, timelineTrusted: false });
  // The real length wins over the model's estimate, and a large mismatch also distrusts the timeline.
  assert.deepEqual(assessVideo(JSON.stringify({ ...accepted, duration: '10:00' }), 180), { durationSeconds: 180, timelineTrusted: false });
  assert.deepEqual(assessVideo(JSON.stringify({ ...accepted, duration: '3:05' }), 180), { durationSeconds: 180, timelineTrusted: true });
  // A length or moment written as plain seconds is the confusion this format prevents, so the timeline is not trusted.
  assert.deepEqual(assessVideo(JSON.stringify({ ...accepted, duration: '180' }), 180), { durationSeconds: 180, timelineTrusted: false });
  assert.deepEqual(assessVideo(JSON.stringify({ ...accepted, observations: [{ at: '12', evidence: 'Autor gotuje makaron w garnku.' }, accepted.observations[1]] }), 180), { durationSeconds: 180, timelineTrusted: false });
  assert.deepEqual(assessVideo(JSON.stringify({ ...accepted, duration: 'około 3 minut' })), { durationSeconds: null, timelineTrusted: false });
  assert.throws(() => assessVideo(JSON.stringify({ ...accepted, observations: [{ at: '0:50', evidence: 'Mieszanie ciasta w misce.' }, { at: '0:50', evidence: 'Mieszanie ciasta w misce.' }] })));
});

test('reads step moments only from player clock strings', async () => {
  const { parseMoment } = await import('../lib/video-moment.ts');
  assert.deepEqual(['0:09', '1:25', '01:25', '12:30', '1:02:05', '2:39.6'].map(parseMoment), [9, 85, 85, 750, 3725, 159]);
  // 125 can mean 125 s or 1:25; the placki ziemniaczane recipe had both kinds in one answer.
  assert.deepEqual(['125', '2.05', '2:75', '1:5', '', 'około 2 minut'].map(parseMoment), [null, null, null, null, null, null]);
  const step = at => ({ title: 'Krok', description: 'Opis kroku.', at, atEvidence: 'Autor ściera ziemniaki na tarce.' });
  const recipe = formatVideoRecipe(JSON.stringify({ ...output, steps: [step('0:44'), step('1:25'), step(125), step('2.05'), step('2:39')] }), 'SwDJi_PB-wY', 255);
  assert.deepEqual(recipe.steps.map(item => item.at), [44, 85, null, null, 159]);
  // A chatty value loses only its own moment, not the whole recipe.
  const chatty = formatVideoRecipe(JSON.stringify({ ...output, steps: [step('0:44'), step('około 2:05, gdy autor dodaje cebulę do ziemniaków')] }), 'SwDJi_PB-wY', 255);
  assert.deepEqual(chatty.steps.map(item => item.at), [44, null]);
});

test('tells the model the real video length before it marks step moments', async t => {
  process.env.YOUTUBE_LENGTH_LOOKUP = 'on';
  t.after(() => { process.env.YOUTUBE_LENGTH_LOOKUP = 'off'; });
  let instruction = '';
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).startsWith('https://www.youtube.com/watch')) return new Response('<script>{"videoDetails":{"lengthSeconds":"255"}}</script>');
    const body = JSON.parse(init.body);
    if (!body.response_format.schema.properties.category) instruction = body.system_instruction;
    return responseFor(init);
  });
  const recipe = await generateRecipe('SwDJi_PB-wY');
  assert.match(instruction, /Film trwa 4:15\./);
  assert.equal(recipe.steps[0].at, null, 'the model guessed 3:00 for a 4:15 video, so its timeline is not trusted');
});
