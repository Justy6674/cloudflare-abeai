// index.js - Complete, Corrected AbeAI Cloudflare Worker

const BASE_PROMPT = (allergies, fitnessLevel, tier, isAustralian) => `
You are AbeAI, a patient-first, empathetic, clinically-focused health coach for obesity management, tailored specifically for Australian users. Follow these rules exactly:
1. Subscription tiers:
   - Free: Basic advice, strictly limit detailed answers; always include empathetic upsell suggestions after 3–5 free interactions.
   - Essentials: Moderate detail, occasional gentle upsells.
   - Premium/Clinical: Highly detailed, personalized, medical-grade guidance.
2. Explicitly consider user's allergies/intolerances: ${allergies.length ? allergies.join(", ") : "none"}.
3. Strictly adjust recommendations to user's fitness level: ${fitnessLevel}.
4. Always use Australian metrics (kg, cm, litres).
5. If ${isAustralian}, always start responses with welcoming PT greeting: "Olá!".
6. Never repeat previous answers—reference user's recent conversation history.
7. End every response with an engaging, personalized follow-up question to encourage continued interaction.
`;

const MONETIZATION_TRIGGERS = {
  nutrition: {
    keywords: ["snack", "meal", "protein", "recipe", "diet"],
    freeResponse: "Here are 3 quick options. For personalized meal plans:",
    upsell: "Explore Essentials"
  },
  fitness: {
    keywords: ["workout", "exercise", "gym", "run", "steps"],
    freeResponse: "Here’s a great beginner exercise tip. For personalized workout routines:",
    upsell: "Explore Premium"
  },
  clinical: {
    keywords: ["bmi", "insulin", "thyroid", "bariatric", "medication"],
    freeResponse: "Here’s some general guidance. For clinical-level personalized support:",
    upsell: "Explore Clinical"
  },
  mental: {
    keywords: ["stress-eat", "binge", "self-esteem", "sleep"],
    freeResponse: "Here’s an initial step. For detailed emotional and behavioural support:",
    upsell: "Explore Premium"
  }
};

const FALLBACK_RESPONSES = {
  welcome: "Olá! I'm AbeAI, your personal health coach. How can I support your health journey today?",
  generic: "I'm here to help. Could you tell me more or ask a specific question about your health goals?"
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

function detectMonetizationCategory(message) {
  const lowerMsg = message.toLowerCase();
  return Object.entries(MONETIZATION_TRIGGERS).find(([_, cfg]) =>
    cfg.keywords.some(kw => lowerMsg.includes(kw))
  )?.[0] || null;
}

function buildPrompt(userData, message) {
  const { tier, history, context } = userData;
  const monetizationCategory = detectMonetizationCategory(message);
  let prompt = BASE_PROMPT(context.allergies, context.fitnessLevel, tier, context.isAustralian);

  if (tier === "free" && monetizationCategory) {
    prompt += `\nIMPORTANT: User is on free tier. Limit detailed ${monetizationCategory} responses and clearly suggest upgrading.`;
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
  if (!res.ok) throw new Error("AI response failed");
  return (await res.json()).choices[0].message.content;
}

function formatResponse(content, userData, monetizationCategory, env) {
  let response = { content, buttons: [] };
  const triggerUpsell = env.FORCE_MONETIZATION === "true";

  if ((userData.tier === "free" || triggerUpsell) && monetizationCategory) {
    const config = MONETIZATION_TRIGGERS[monetizationCategory];
    response.content = `${config.freeResponse}\n\n${content}`;
    response.buttons.push({
      text: config.upsell,
      url: "https://downscaleai.com"
    });
  }

  if (userData.context.isAustralian) {
    response.buttons.push({
      text: "Visit Downscale Clinics",
      url: "https://www.downscale.com.au"
    });
  }

  return response;
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: corsHeaders });
    }

    try {
      const { message, user_id, context = {} } = await parseJSON(request);
      if (!message || !user_id) throw new Error("Missing required fields");

      const userData = await getUserData(user_id, env);
      const monetizationCategory = detectMonetizationCategory(message);

      if (message.toLowerCase() === "welcome") {
        return new Response(JSON.stringify({
          response: FALLBACK_RESPONSES.welcome,
          upgrade_suggested: false
        }), { headers: corsHeaders });
      }

      userData.history.push(message);
      if (userData.history.length > 5) userData.history.shift();

      await saveUserData(user_id, { ...userData, context: { ...userData.context, ...context } }, env);

      const promptMessages = buildPrompt(userData, message);
      const aiResponse = await handleAIRequest(promptMessages, env, userData.tier);
      const formattedResponse = formatResponse(aiResponse, userData, monetizationCategory, env);

      return new Response(JSON.stringify({
        response: formattedResponse.content,
        buttons: formattedResponse.buttons,
        upgrade_suggested: formattedResponse.buttons.length > 0
      }), { headers: corsHeaders });

    } catch (error) {
      console.error("Error:", error);
      return new Response(JSON.stringify({
        response: FALLBACK_RESPONSES.generic,
        error: error.message
      }), { status: 500, headers: corsHeaders });
    }
  }
};
