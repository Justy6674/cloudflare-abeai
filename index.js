// Final, Corrected AbeAI Cloudflare Worker (index.js)

const BASE_PROMPT = (allergies, fitnessLevel, tier, isAustralian) => `
You are AbeAI, an empathetic, patient-first health coach focused on obesity management. Follow these rules precisely:
1. Subscription tiers:
   - Free: Basic guidance (max 3 suggestions), include gentle, empathetic upsells.
   - Essentials: Moderate guidance, suggest Premium if deeper personalisation could help.
   - Premium/Clinical: Detailed, medically robust guidance, no upsells.
2. Consider allergies/intolerances explicitly: ${allergies.length ? allergies.join(", ") : "none"}.
3. Tailor responses strictly to fitness level: ${fitnessLevel}.
4. Use Australian metrics (kg, cm, litres).
5. ${isAustralian ? "Begin every response warmly with a friendly Australian greeting." : ""}
6. Do not repeat previous responses—reference history.
7. End each response with a thoughtful, engaging follow-up question.
`;

const MONETIZATION_TRIGGERS = {
  nutrition: ["snack", "meal", "protein", "recipe", "diet"],
  fitness: ["workout", "exercise", "gym", "run", "steps"],
  clinical: ["bmi", "insulin", "thyroid", "bariatric", "medication"],
  mental: ["stress-eat", "binge", "self-esteem", "sleep"]
};

async function parseJSON(request) {
  try { return await request.json(); }
  catch { return { error: true }; }
}

async function getUserData(user_id, env) {
  return await env.ABEAI_KV.get(`user:${user_id}`, "json") || {
    tier: "free",
    history: [],
    context: { allergies: [], fitnessLevel: "beginner", isAustralian: true }
  };
}

async function saveUserData(user_id, data, env) {
  await env.ABEAI_KV.put(`user:${user_id}`, JSON.stringify(data));
}

function detectCategory(message) {
  const msg = message.toLowerCase();
  return Object.entries(MONETIZATION_TRIGGERS).find(([_, kws]) => kws.some(k => msg.includes(k)))?.[0];
}

function buildPrompt(userData, message) {
  const { tier, history, context } = userData;
  const category = detectCategory(message);

  let prompt = BASE_PROMPT(context.allergies, context.fitnessLevel, tier, context.isAustralian);

  if (tier === "free" && category) {
    prompt += `\nUser is on free tier—limit ${category} response and provide empathetic upsell.`;
  }

  return [
    { role: "system", content: prompt },
    ...history.slice(-5).map(h => ({ role: "user", content: h })),
    { role: "user", content: message }
  ];
}

async function handleAIRequest(messages, env, tier) {
  const res = await fetch("https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages,
      temperature: 0.7,
      max_tokens: tier === "Premium" ? 400 : 200
    })
  });

  if (!res.ok) throw new Error("AI service error");
  return (await res.json()).choices[0].message.content;
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST method only" }), { status: 405, headers: corsHeaders });
    }

    try {
      const { message, user_id, context = {} } = await parseJSON(request);
      if (!message || !user_id) throw new Error("Missing required fields");

      const userData = await getUserData(user_id, env);
      const category = detectCategory(message);

      if (message.toLowerCase() === "welcome") {
        return new Response(JSON.stringify({
          response: userData.context.isAustralian ? "G'day! I'm AbeAI, your Aussie health coach. How can I help today?" : "Hello! I'm AbeAI, your personal health coach. How can I help today?",
          upgrade_suggested: false
        }), { headers: corsHeaders });
      }

      userData.history.push(message);
      if (userData.history.length > 5) userData.history.shift();
      await saveUserData(user_id, { ...userData, context: { ...userData.context, ...context } }, env);

      const aiResponse = await handleAIRequest(buildPrompt(userData, message), env, userData.tier);

      const responsePayload = { response: aiResponse, upgrade_suggested: userData.tier === "free" && category };

      if (responsePayload.upgrade_suggested) {
        responsePayload.buttons = [{ text: "Get Personalised Help", url: "https://downscaleai.com" }];
      }

      if (userData.context.isAustralian) {
        responsePayload.buttons = responsePayload.buttons || [];
        responsePayload.buttons.push({ text: "Visit Downscale Clinics", url: "https://www.downscale.com.au" });
      }

      return new Response(JSON.stringify(responsePayload), { headers: corsHeaders });

    } catch (error) {
      return new Response(JSON.stringify({ response: "I'm here to help. Can you clarify your question?", error: error.message }), { status: 500, headers: corsHeaders });
    }
  }
};
