// abeai-cloudflare-worker/index.js - OPTIMIZED VERSION

const BASE_PROMPT = `
You are AbeAI, an empathetic, data-driven health coach. Follow these rules:
1. For free users: Provide basic advice with upsell prompts
2. For PAYG/Essentials: Give mid-tier advice with occasional upsells
3. For Premium: Offer detailed, personalized guidance
4. Always consider allergies: {{ALLERGIES}}
5. Adapt to fitness level: {{FITNESS_LEVEL}}
6. For Australians: Include PT (Portuguese) responses first
7. Never repeat answers - check history first
8. End with engaging follow-up questions
`;

// Monetization triggers (expanded from your original)
const MONETIZATION_TRIGGERS = {
  nutrition: {
    keywords: ["snack", "meal", "protein", "recipe", "diet"],
    freeResponse: "Here are 3 ideas to start. For 20+ personalized options:",
    upsell: "Upgrade to Essentials"
  },
  fitness: {
    keywords: ["workout", "exercise", "gym", "run"],
    freeResponse: "Try this beginner routine. For custom plans:",
    upsell: "Upgrade to Premium"
  },
  // ... add other categories from your original list
};

async function parseJSON(request) {
  try {
    return await request.json();
  } catch (err) {
    return { error: true, message: "Invalid JSON" };
  }
}

async function getUserData(user_id, env) {
  try {
    const data = await env.ABEAI_KV.get(`user:${user_id}`, "json");
    return data || {
      tier: "free",
      history: [],
      context: { allergies: [], fitnessLevel: "beginner" }
    };
  } catch (err) {
    console.error("KV read error:", err);
    return {
      tier: "free",
      history: [],
      context: { allergies: [], fitnessLevel: "beginner" }
    };
  }
}

async function saveUserData(user_id, data, env) {
  try {
    await env.ABEAI_KV.put(`user:${user_id}`, JSON.stringify(data));
  } catch (err) {
    console.error("KV write error:", err);
  }
}

function detectMonetizationCategory(message) {
  const lowerMsg = message.toLowerCase();
  for (const [category, config] of Object.entries(MONETIZATION_TRIGGERS)) {
    if (config.keywords.some(kw => lowerMsg.includes(kw))) {
      return category;
    }
  }
  return null;
}

function buildPrompt(userData, message) {
  const { tier, history, context } = userData;
  const monetizationCategory = detectMonetizationCategory(message);

  let prompt = BASE_PROMPT
    .replace("{{ALLERGIES}}", context.allergies?.join(", ") || "none")
    .replace("{{FITNESS_LEVEL}}", context.fitnessLevel || "beginner");

  if (tier === "free" && monetizationCategory) {
    prompt += `\nNOTE: User is free tier - limit ${monetizationCategory} response`;
  }

  const messages = [
    { role: "system", content: prompt },
    ...history.slice(-3).map(h => ({ role: "user", content: h })),
    { role: "user", content: message }
  ];

  return messages;
}

async function handleAIRequest(messages, env) {
  try {
    const response = await fetch("https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/v1/chat/completions", {
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

    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = await response.json();
    return data.choices[0].message.content;
  } catch (err) {
    console.error("AI request failed:", err);
    throw err;
  }
}

function formatResponse(content, userData, monetizationCategory) {
  let response = { content };
  
  if (userData.tier === "free" && monetizationCategory) {
    const config = MONETIZATION_TRIGGERS[monetizationCategory];
    response.content = `${config.freeResponse}\n\n${content}`;
    response.buttons = [{
      text: config.upsell,
      url: `/upgrade?category=${monetizationCategory}`
    }];
  }

  if (userData.context.isAustralian) {
    response.content = `[PT] Olá!\n${response.content}`;
    if (userData.tier !== "Premium") {
      response.buttons = response.buttons || [];
      response.buttons.push({
        text: "Downscale Clinics",
        url: "https://www.downscale.com.au"
      });
    }
  }

  return response;
}

export default {
  async fetch(request, env) {
    // CORS Setup
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    try {
      const { message, user_id, context = {} } = await parseJSON(request);
      if (!message || !user_id) throw new Error("Missing required fields");

      // Get/Create user data
      const userData = await getUserData(user_id, env);
      const monetizationCategory = detectMonetizationCategory(message);

      // Build and update history
      const newHistory = [...userData.history.slice(-4), message];
      await saveUserData(user_id, {
        ...userData,
        history: newHistory,
        context: { ...userData.context, ...context }
      });

      // Process with OpenAI
      const messages = buildPrompt(userData, message);
      const aiResponse = await handleAIRequest(messages, env);

      // Format final response
      const formatted = formatResponse(aiResponse, userData, monetizationCategory);

      return new Response(JSON.stringify(formatted), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } catch (err) {
      console.error("Error:", err);
      return new Response(JSON.stringify({ 
        error: "Service unavailable",
        details: err.message 
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
