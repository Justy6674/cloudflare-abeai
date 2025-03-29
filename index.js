const BASE_PROMPT = `
You are AbeAI, an empathetic, Australian-focused health coach.
1. Provide brief, empathetic responses.
2. Include Australian spelling and cultural references.
3. Free users get limited but helpful answers with clear subscription upsells.
4. Always consider user allergies: {{ALLERGIES}}
5. Adjust advice based on fitness level: {{FITNESS_LEVEL}}
6. End every response encouraging further engagement.
`;

const MONETIZATION_TRIGGERS = {
  nutrition: {
    keywords: ["snack", "meal", "protein", "recipe", "diet"],
    freeResponse: "Here are 3 quick snack ideas: Greek yoghurt and berries, Vegemite on wholegrain toast, or boiled eggs. For a full list of personalised snack ideas:",
    button: "Unlock Personalised Meal Plans",
    url: "https://abeai.health/upgrade?category=nutrition",
    tiers: ["Essentials", "Premium"]
  },
  fitness: {
    keywords: ["workout", "exercise", "gym", "run"],
    freeResponse: "Here's a simple routine: 20-minute walk daily. For tailored workouts:",
    button: "Get Custom Fitness Plans",
    url: "https://abeai.health/upgrade?category=fitness",
    tiers: ["Essentials", "Premium"]
  },
  metrics: {
    keywords: ["bmi", "calories", "weight", "body fat"],
    freeResponse: "I can quickly calculate this for you. For detailed tracking and analysis:",
    button: "Detailed Metrics & Analysis",
    url: "https://abeai.health/upgrade?category=metrics",
    tiers: ["PAYG", "Essentials", "Premium"]
  },
  hydration: {
    keywords: ["water", "hydration", "drink"],
    freeResponse: "Aim for about 2-3 litres daily. For personalised tracking:",
    button: "Activate Hydration Tracker",
    url: "https://abeai.health/upgrade?category=hydration",
    tiers: ["Essentials", "Premium"]
  },
  mentalHealth: {
    keywords: ["stress", "sleep", "mood", "anxiety"],
    freeResponse: "Managing stress is vital. For guided mental health support:",
    button: "Explore Mental Health Coaching",
    url: "https://abeai.health/upgrade?category=mentalHealth",
    tiers: ["Premium"]
  }
};

async function parseJSON(request) {
  try { return await request.json(); } 
  catch { throw new Error("Invalid JSON input."); }
}

async function getUserData(user_id, env) {
  return await env.ABEAI_KV.get(`user:${user_id}`, "json") || {
    tier: "free",
    context: { allergies: [], fitnessLevel: "beginner", isAustralian: true },
    history: []
  };
}

async function saveUserData(user_id, data, env) {
  await env.ABEAI_KV.put(`user:${user_id}`, JSON.stringify(data));
}

function detectTrigger(message) {
  const msg = message.toLowerCase();
  return Object.keys(MONETIZATION_TRIGGERS).find(category =>
    MONETIZATION_TRIGGERS[category].keywords.some(k => msg.includes(k))
  ) || null;
}

function buildPrompt(userData, message, category) {
  const prompt = BASE_PROMPT
    .replace("{{ALLERGIES}}", userData.context.allergies.join(", ") || "none")
    .replace("{{FITNESS_LEVEL}}", userData.context.fitnessLevel);

  return [
    { role: "system", content: prompt },
    { role: "user", content: message },
    { role: "system", content: category ? `Provide a brief answer specifically on ${category}.` : '' }
  ];
}

async function fetchOpenAI(messages, env) {
  const res = await fetch("https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages,
      max_tokens: 250,
      temperature: 0.7
    })
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

function formatResponse(aiResponse, userData, category) {
  if (userData.tier === "free" && category) {
    const trigger = MONETIZATION_TRIGGERS[category];
    return {
      content: `${trigger.freeResponse}\n\n${aiResponse}`,
      buttons: [{ text: trigger.button, url: trigger.url }]
    };
  }
  return { content: aiResponse };
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      const { message, user_id, context } = await parseJSON(request);
      if (!message || !user_id) throw new Error("User ID and message required.");

      const userData = await getUserData(user_id, env);
      if (context) userData.context = { ...userData.context, ...context };

      const category = detectTrigger(message);
      const messages = buildPrompt(userData, message, category);
      const aiResponse = await fetchOpenAI(messages, env);

      userData.history.push({ user: message, ai: aiResponse });
      await saveUserData(user_id, userData, env);

      const responsePayload = formatResponse(aiResponse, userData, category);

      return new Response(JSON.stringify(responsePayload), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ error: "Service unavailable", details: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
