const BASE_PROMPT = `
You are AbeAI, an empathetic, patient-first Australian health coach. Follow these rules strictly:
1. Free tier: Brief helpful responses followed by respectful upsell.
2. PAYG/Essentials: Moderate detail with occasional respectful upsell.
3. Premium: Detailed personalised Australian-focused guidance.
4. Consider allergies carefully: {{ALLERGIES}}
5. Adapt advice strictly to user's fitness level: {{FITNESS_LEVEL}}
6. For Australians, encourage clinical support and professional consultations if appropriate.
7. Never repeat previous answers; always refer to history.
8. End each response with an engaging follow-up question.
`;

const MONETIZATION_TRIGGERS = {
  nutrition: {
    keywords: ["snack", "meal", "protein", "recipe", "diet", "nutrition"],
    freeResponse: "Here’s a quick suggestion. For personalised Australian meal plans:",
    button: "Explore Meal Plans",
    url: "https://www.downscale.com.au/upgrade?category=nutrition"
  },
  fitness: {
    keywords: ["workout", "exercise", "gym", "run", "activity", "fitness"],
    freeResponse: "Try this simple Aussie-friendly routine. For tailored fitness plans:",
    button: "Get Your Fitness Plan",
    url: "https://www.downscale.com.au/upgrade?category=fitness"
  },
  metrics: {
    keywords: ["bmi", "calories", "kilojoules", "weight", "body fat", "measurement"],
    freeResponse: "Here's your basic summary. Want detailed, clinical-grade analysis?",
    button: "Detailed Metrics Analysis",
    url: "https://www.downscale.com.au/upgrade?category=metrics"
  },
  hydration: {
    keywords: ["water", "hydration", "drink", "fluid"],
    freeResponse: "Hydration matters, especially in Australia! Want personalised reminders?",
    button: "Hydration Reminders",
    url: "https://www.downscale.com.au/upgrade?category=hydration"
  },
  mentalHealth: {
    keywords: ["stress", "sleep", "mood", "anxiety"],
    freeResponse: "Mental health is vital. Interested in personalised mental wellbeing support?",
    button: "Mental Health Coaching",
    url: "https://www.downscale.com.au/upgrade?category=mental_health"
  },
  intimacy: {
    keywords: ["intimacy", "relationship", "sex", "partner", "marriage"],
    freeResponse: "Intimacy is important for wellbeing. Need secure, guided support?",
    button: "Access Intimacy Coaching",
    url: "https://www.downscale.com.au/upgrade?category=intimacy"
  },
  medication: {
    keywords: ["medication", "dose", "side effects", "drug", "ozempic", "wegovy", "mounjaro"],
    freeResponse: "Medication requires careful management. Seeking comprehensive support?",
    button: "Secure Medication Guidance",
    url: "https://www.downscale.com.au/upgrade?category=medication"
  }
};

async function parseJSON(request) {
  try {
    return await request.json();
  } catch {
    return { error: true, message: "Invalid JSON format." };
  }
}

async function getUserData(user_id, env) {
  try {
    return await env.ABEAI_KV.get(`user:${user_id}`, "json") || {
      tier: "free",
      history: [],
      context: { allergies: [], fitnessLevel: "beginner", motivationLevel: "moderate" }
    };
  } catch (err) {
    console.error("KV read error:", err);
    return {
      tier: "free",
      history: [],
      context: { allergies: [], fitnessLevel: "beginner", motivationLevel: "moderate" }
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

function detectTrigger(message) {
  const lowerMsg = message.toLowerCase();
  for (const [category, config] of Object.entries(MONETIZATION_TRIGGERS)) {
    if (config.keywords.some(keyword => lowerMsg.includes(keyword))) return category;
  }
  return null;
}

function buildPrompt(userData, message, category) {
  let prompt = BASE_PROMPT
    .replace("{{ALLERGIES}}", userData.context.allergies.join(", ") || "none")
    .replace("{{FITNESS_LEVEL}}", userData.context.fitnessLevel);

  prompt += category ? `\nNOTE: Respond briefly to ${category}.` : "";

  return [
    { role: "system", content: prompt },
    ...userData.history.slice(-3).map(h => ({ role: "user", content: h })),
    { role: "user", content: message }
  ];
}

async function handleAIRequest(messages, env, tier) {
  const res = await fetch("https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages,
      temperature: 0.7,
      max_tokens: tier === "Premium" ? 400 : 200
    })
  });
  if (!res.ok) throw new Error(`OpenAI API Error: ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

function formatResponse(aiContent, userData, category) {
  const response = { content: aiContent, buttons: [] };
  const trigger = MONETIZATION_TRIGGERS[category];

  if (category && ["free", "PAYG"].includes(userData.tier)) {
    response.content += `\n\n${trigger.freeResponse}`;
    response.buttons.push({ text: trigger.button, url: trigger.url });
  }

  if (userData.context.isAustralian && userData.tier !== "Premium") {
    response.buttons.push({ text: "Downscale Clinics", url: "https://www.downscale.com.au" });
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
      const { message, user_id } = await parseJSON(request);
      if (!message || !user_id) throw new Error("Required fields missing.");

      const userData = await getUserData(user_id, env);
      const category = detectTrigger(message);

      userData.history.push(message);
      await saveUserData(user_id, userData, env);

      const prompt = buildPrompt(userData, message, category);
      const aiResponse = await handleAIRequest(prompt, env, userData.tier);
      const formatted = formatResponse(aiResponse, userData, category);

      return new Response(JSON.stringify(formatted), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (err) {
      console.error("Worker error:", err);
      return new Response(JSON.stringify({ error: "Service temporarily unavailable. Please try again later." }), { status: 500, headers: corsHeaders });
    }
  }
};
