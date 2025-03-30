// AbeAI Cloudflare Worker - Australian-centric, Safety-first, Clinically Optimized

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

const BASE_PROMPT = (user) => `
You are AbeAI, an empathetic, clinically-focused obesity health coach for Australians. Use friendly, supportive, PT-first (people-first) language aligned with worldobesity.org guidelines.

Explicitly emphasize Australian foods, supermarkets (Coles, Woolworths, Aldi, IGA), popular Australian takeaways, and culturally relevant meals (e.g., Vegemite toast, Weet-Bix, Tim Tams, kangaroo steaks, chicken parmigiana, barramundi).

Always tailor responses to the user's context:
- Allergies/Intolerances: ${user.context.allergies || 'None'}
- Physical Injuries/Limitations: ${user.context.injuries || 'None'}
- Current Medications or Clinical conditions: ${user.context.medications || 'None'}
- Mental Health conditions or concerns: ${user.context.mentalHealth || 'None'}

Use metric (kg, cm, litres) exclusively. Reference Australian clinical services like Downscale Clinics when appropriate.

Apply Maslow’s hierarchy clearly:
- Physiological needs: practical dietary/activity advice.
- Safety needs: clinical reassurance, injury precautions, medication advice.
- Belongingness: encourage community support.
- Esteem: motivation, positive reinforcement.
- Self-actualization: encourage reflection and sustained lifestyle change.

End all interactions with engaging follow-up questions encouraging further personalized support and exploration of subscription plans.
`;

const MONETIZATION_TRIGGERS = {
  clinical: ["bmi", "insulin", "thyroid", "bariatric", "medication", "plateau", "metabolism"],
  nutrition: ["snack", "meal", "recipe", "protein", "carbs", "diet", "fasting", "belly fat"],
  activity: ["exercise", "workout", "steps", "yoga", "pain", "knees", "activity"],
  mental: ["stress", "binge", "emotional eating", "self-esteem", "sleep", "motivation"],
  adolescent: ["teen", "child", "kid", "adolescent", "parent"],
  medication: ["ozempic", "wegovy", "mounjaro", "saxenda", "zepbound", "glp-1", "injection"]
};

async function fetchUser(user_id, env) {
  const data = await env.ABEAI_KV.get(`user:${user_id}`, "json");
  return data || {
    tier: "free",
    context: {},
    history: [],
    freeResponses: 0,
    isAustralian: true
  };
}

async function saveUser(user_id, user, env) {
  await env.ABEAI_KV.put(`user:${user_id}`, JSON.stringify(user));
}

async function callOpenAI(prompt, message, user, env) {
  const res = await fetch("https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: message }
      ],
      temperature: 0.6,
      max_tokens: { free: 150, PAYG: 200, Essentials: 250, Premium: 350, Clinical: 500 }[user.tier] || 150
    })
  });
  return (await res.json()).choices[0].message.content;
}

function detectPillar(msg) {
  for (const [pillar, keywords] of Object.entries(MONETIZATION_TRIGGERS)) {
    if (keywords.some(keyword => msg.includes(keyword))) return pillar;
  }
  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (request.method !== "POST") return new Response("POST only", { status: 405, headers: corsHeaders });

    const { user_id, message, safetyResponse } = await request.json();
    if (!user_id || !message) return new Response("Missing user_id/message", { status: 400, headers: corsHeaders });

    const user = await fetchUser(user_id, env);
    const lowerMsg = message.toLowerCase();
    const pillar = detectPillar(lowerMsg);

    if (pillar && !user.context[pillar] && !safetyResponse) {
      const safetyPrompts = {
        clinical: "Before we proceed, do you have any medical conditions or are you on any medications?",
        nutrition: "Just to ensure safety, do you have any food allergies or intolerances?",
        activity: "Do you have any injuries or physical limitations I should consider?",
        mental: "Are you currently experiencing stress, anxiety, depression or receiving mental health support?",
        adolescent: "Are you seeking support for a teen or child?",
        medication: "Are you currently taking any medications or interested in weight management medications?"
      };

      return new Response(JSON.stringify({
        response: safetyPrompts[pillar],
        requestSafetyInfo: pillar
      }), { headers: corsHeaders });
    }

    if (safetyResponse && pillar) {
      user.context[pillar] = safetyResponse;
      await saveUser(user_id, user, env);
      return new Response(JSON.stringify({
        response: `Thank you for sharing. To get comprehensive and personalized ${pillar} support, our tailored plans can greatly help.`,
        upgradeSuggested: true,
        buttons: [{ text: `Explore ${pillar} Support`, url: `https://downscaleai.com/${pillar}` },
          user.isAustralian && { text: "Book at Downscale Clinics", url: "https://www.downscale.com.au" }].filter(Boolean)
      }), { headers: corsHeaders });
    }

    if (user.tier === "free") {
      user.freeResponses = (user.freeResponses || 0) + 1;
      if (user.freeResponses > 3) {
        await saveUser(user_id, user, env);
        return new Response(JSON.stringify({
          response: "I've helped with some basics, and I'd love to support you more comprehensively with personalized plans.",
          upgradeSuggested: true,
          buttons: [
            { text: "PAYG Plan", url: "https://downscaleai.com/payg" },
            { text: "Essentials Plan", url: "https://downscaleai.com/essentials" },
            { text: "Premium Plan", url: "https://downscaleai.com/premium" },
            user.isAustralian && { text: "Clinical Plan", url: "https://downscaleai.com/clinical" }
          ].filter(Boolean)
        }), { headers: corsHeaders });
      }
    }

    const prompt = BASE_PROMPT(user);
    const aiReply = await callOpenAI(prompt, message, user, env);

    user.history.push({ message, aiReply });
    if (user.history.length > 5) user.history.shift();
    await saveUser(user_id, user, env);

    return new Response(JSON.stringify({
      response: aiReply,
      upgradeSuggested: ["free", "PAYG"].includes(user.tier),
      buttons: ["free", "PAYG"].includes(user.tier) ? [
        { text: "Essentials Plan", url: "https://downscaleai.com/essentials" },
        { text: "Premium Plan", url: "https://downscaleai.com/premium" },
        user.isAustralian && { text: "Clinical Plan", url: "https://downscaleai.com/clinical" },
        user.isAustralian && { text: "Downscale Clinics", url: "https://www.downscale.com.au" }
      ].filter(Boolean) : []
    }), { headers: corsHeaders });
  }
};
