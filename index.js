// abeai-cloudflare-worker/index.js (Optimized & Corrected)

const BASE_PROMPT = `
You are AbeAI, an empathetic, Australian-focused health coach. Follow these guidelines strictly:
1. Provide brief, empathetic responses.
2. Use Australian spelling and cultural references.
3. Always consider user allergies: {{ALLERGIES}}.
4. Adjust responses based on fitness level: {{FITNESS_LEVEL}}.
5. End each response with a clear and engaging follow-up question.
`;

const MONETIZATION_TRIGGERS = {
  nutrition: {
    keywords: ["snack", "meal", "protein", "recipe", "diet", "nutrition", "eat"],
    freeResponse: "Here’s a brief response. Want personalised nutrition advice tailored to Australian tastes?",
    upsell: "Explore Nutrition Plans"
  },
  fitness: {
    keywords: ["workout", "exercise", "gym", "run", "activity", "fitness"],
    freeResponse: "Here's a quick tip. Interested in a customised fitness plan?",
    upsell: "Personalised Fitness Plan"
  },
  metrics: {
    keywords: ["bmi", "calories", "weight", "body fat", "measurements"],
    freeResponse: "Here's your quick result. Would you like detailed, medical-grade tracking?",
    upsell: "Detailed Metrics Analysis"
  },
  hydration: {
    keywords: ["water", "hydration", "drink", "fluid"],
    freeResponse: "Basic hydration info provided. Want personalised hydration reminders?",
    upsell: "Activate Hydration Reminders"
  },
  mentalHealth: {
    keywords: ["stress", "sleep", "mood", "anxiety"],
    freeResponse: "Mental wellness matters. Interested in tailored mental health coaching?",
    upsell: "Mental Health Coaching"
  },
  intimacy: {
    keywords: ["intimacy", "relationship", "sex", "partner", "marriage"],
    freeResponse: "Here's some basic guidance. Would you like secure intimacy support?",
    upsell: "Intimacy Coaching"
  },
  medication: {
    keywords: ["medication", "dose", "side effects", "drug", "ozempic", "wegovy", "mounjaro"],
    freeResponse: "Medication needs careful guidance. Want detailed medication management?",
    upsell: "Medication Guidance"
  }
};

async function parseJSON(request) {
  try { return await request.json(); }
  catch { return { error: "Invalid JSON" }; }
}

async function getUserData(user_id, env) {
  return (await env.ABEAI_KV.get(`user:${user_id}`, "json")) || {
    tier: "free", history: [], context: { allergies: [], fitnessLevel: "beginner", isAustralian: true }
  };
}

async function saveUserData(user_id, data, env) {
  await env.ABEAI_KV.put(`user:${user_id}`, JSON.stringify(data));
}

function detectTrigger(message) {
  const msg = message.toLowerCase();
  return Object.keys(MONETIZATION_TRIGGERS).find(cat =>
    MONETIZATION_TRIGGERS[cat].keywords.some(kw => msg.includes(kw))
  );
}

function buildPrompt(userData, message, category) {
  return [
    { role: "system", content: BASE_PROMPT.replace("{{ALLERGIES}}", userData.context.allergies.join(", ") || "none")
      .replace("{{FITNESS_LEVEL}}", userData.context.fitnessLevel || "beginner") },
    { role: "user", content: message },
    ...(category ? [{ role: "system", content: `Provide a brief answer specifically on ${category}.` }] : [])
  ];
}

async function handleAIRequest(messages, env) {
  const res = await fetch("https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-3.5-turbo", messages, temperature: 0.7 })
  });
  return (await res.json()).choices[0].message.content;
}

function formatResponse(content, userData, category) {
  const response = { content };
  if (userData.tier === "free" && category) {
    response.content = `${MONETIZATION_TRIGGERS[category].freeResponse}\n\n${content}`;
    response.buttons = [{ text: MONETIZATION_TRIGGERS[category].upsell, url: `https://www.downscale.com.au/subscribe?category=${category}` }];
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

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

    try {
      const { message, user_id, context } = await parseJSON(request);
      if (!message || !user_id) throw new Error("Missing required fields");

      const userData = await getUserData(user_id, env);
      userData.context = { ...userData.context, ...context };
      userData.history.push(message);
      await saveUserData(user_id, userData, env);

      const category = detectTrigger(message);
      const prompt = buildPrompt(userData, message, category);
      const aiResponse = await handleAIRequest(prompt, env);
      const formatted = formatResponse(aiResponse, userData, category);

      return new Response(JSON.stringify(formatted), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (err) {
      console.error("Error:", err);
      return new Response(JSON.stringify({ error: "Service unavailable", details: err.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
