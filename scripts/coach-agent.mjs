// Create or update the ElevenLabs agent behind the workout coach.
//
//     npm run coach:agent          # reads ELEVENLABS_API_KEY (and ELEVENLABS_AGENT_ID, if set) from .env
//
// With ELEVENLABS_AGENT_ID set, that agent is updated; otherwise an agent named NAME is found or created.
// Prints the agent id only. Put it in .env and on Render as ELEVENLABS_AGENT_ID.
//
// The prompt, first line and voice here are only defaults: the app overrides them every session from
// src/config/coach.ts, so edit that file to change how the coach behaves. This script just has to allow those overrides.
const API = 'https://api.elevenlabs.io';
const NAME = 'Ricehacks workout coach';
const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error('ELEVENLABS_API_KEY is not set (run with node --env-file=.env).');
  process.exit(1);
}

const agent = {
  name: NAME,
  conversation_config: {
    agent: {
      first_message: "Let's get it. I'm watching your form.",
      language: 'en',
      prompt: {
        prompt: 'You are a chill, upbeat workout buddy. Keep every reply to one short sentence.',
        llm: 'gemini-2.0-flash',
      },
    },
    tts: { model_id: 'eleven_flash_v2' },
    // Heavy breathing shouldn't count as the athlete talking.
    turn: { turn_eagerness: 'patient' },
  },
  platform_settings: {
    overrides: {
      conversation_config_override: {
        agent: { first_message: true, language: false, prompt: { prompt: true } },
        tts: { voice_id: true },
      },
    },
  },
};

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

let id = process.env.ELEVENLABS_AGENT_ID;
if (!id) {
  const { agents = [] } = await call('GET', `/v1/convai/agents?search=${encodeURIComponent(NAME)}&page_size=30`);
  id = agents.find((a) => a.name === NAME)?.agent_id;
}
if (id) {
  await call('PATCH', `/v1/convai/agents/${id}`, agent);
  console.log(`Updated agent ${id}`);
} else {
  ({ agent_id: id } = await call('POST', '/v1/convai/agents/create', agent));
  console.log(`Created agent ${id}`);
}
console.log(`ELEVENLABS_AGENT_ID=${id}`);
