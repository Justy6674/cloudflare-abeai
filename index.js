// AbeAI Backend Script for Cloudflare Worker (Production-Ready)
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
      return new Response("POST only", { status: 405, headers: corsHeaders });
    }

    const { user_id, message, contextUpdate } = await request.json();
    if (!user_id || !message) {
      return new Response("Missing user_id or message", { status: 400, headers: corsHeaders });
    }

    // Retrieve user data from KV
    let user = await env.ABEAI_KV.get(`user:${user_id}`, "json") || {
      tier: "free",
      context: {},
      history: [],
      awaitingSafety: null,
      freeResponseCount: 0,
      isAustralian: true
    };

    // Handle context update from safety prompts
    if (contextUpdate && user.awaitingSafety) {
      user.context[user.awaitingSafety] = contextUpdate;
      user.awaitingSafety = null;
    }

    const pillars = {
      nutrition: {
        keywords: ["snack", "protein", "meal", "diet", "carb", "fasting"],
        safety: "Do you have allergies/intolerances (nuts, dairy, gluten, seafood)?",
        contextKey: "allergies"
      },
      activity: {
        keywords: ["exercise", "workout", "steps", "yoga", "running", "pain"],
        safety: "Any injuries or conditions limiting physical activity?",
        contextKey: "injuries"
      },
      clinical: {
        keywords: ["bmi", "medication", "thyroid", "insulin", "bariatric"],
        safety: "Are you on medications or have any medical conditions?",
        contextKey: "medications"
      },
      mental: {
        keywords: ["stress", "anxiety", "sleep", "emotional eating"],
        safety: "Experiencing stress, anxiety, or depression?",
        contextKey: "mentalHealth"
      }
    };

    let pillar = Object.values(pillars).find(p => p.keywords.some(k => message.toLowerCase().includes(k)));

    if (message.toLowerCase() === "welcome") {
      user.awaitingSafety = "allergies";
      await env.ABEAI_KV.put(`user:${user_id}`, JSON.stringify(user));
      return new Response(JSON.stringify({
        response: "Hello! I'm AbeAI, your personal health coach. Before we begin, do you have allergies or dietary restrictions (e.g., nuts, dairy)?",
        requestContext: "allergies"
      }), { headers: corsHeaders });
    }

    if (pillar && !user.context[pillar.contextKey] && !user.awaitingSafety) {
      user.awaitingSafety = pillar.contextKey;
      await env.ABEAI_KV.put(`user:${user_id}`, JSON.stringify(user));
      return new Response(JSON.stringify({
        response: pillar.safety,
        requestContext: pillar.contextKey
      }), { headers: corsHeaders });
    }

    // Monetization after 3–5 free responses
    if (user.tier === "free" && user.freeResponseCount >= 3) {
      return new Response(JSON.stringify({
        response: "You've reached your free limit. For personalised guidance and clinical support, please explore our subscription options below.",
        buttons: [
          { text: "PAYG", url: "https://downscaleai.com/payg" },
          { text: "Essentials Plan", url: "https://downscaleai.com/essentials" },
          { text: "Premium Plan", url: "https://downscaleai.com/premium" },
          user.isAustralian ? { text: "Clinical Plan (AU)", url: "https://downscaleai.com/clinical" } : null,
          user.isAustralian ? { text: "Book with Downscale Clinics (AU)", url: "https://www.downscale.com.au" } : null
        ].filter(Boolean),
        upgradeSuggested: true
      }), { headers: corsHeaders });
    }

    if (user.tier === "free") user.freeResponseCount += 1;

    const prompt = `
      You're AbeAI, an empathetic Australian health coach specializing in obesity management. 
      Use Australian English and culturally relevant references (Vegemite, kangaroo, Coles, Woolworths). 
      Explicitly consider user context: Allergies: ${user.context.allergies || 'none'}, Injuries: ${user.context.injuries || 'none'}, Medical conditions: ${user.context.medications || 'none'}, Mental health: ${user.context.mentalHealth || 'none'}. 
      Responses must follow WHO and worldobesity.org guidelines—always person-first, respectful, stigma-free. 
      Provide safe, actionable advice and always end with engaging follow-up questions encouraging healthy behaviours.
    `;

    // OpenAI API request
    const openaiRes = await fetch("https://gateway.ai.cloudflare.com/v1/.../openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "system", content: prompt }, { role: "user", content: message }],
        max_tokens: user.tier === "Clinical" ? 500 : user.tier === "Premium" ? 400 : user.tier === "Essentials" ? 300 : user.tier === "PAYG" ? 250 : 200,
        temperature: 0.6
      })
    });

    const aiResponse = await openaiRes.json();
    const reply = aiResponse.choices[0].message.content;

    await env.ABEAI_KV.put(`user:${user_id}`, JSON.stringify(user));

    let buttons = [];
    if (user.tier === "free" || user.tier === "PAYG") {
      buttons = pillar ? [
        { text: `${pillar.contextKey.charAt(0).toUpperCase() + pillar.contextKey.slice(1)} Support`, url: `https://downscaleai.com/${pillar.contextKey}` },
        user.isAustralian ? { text: "Downscale Clinics (AU)", url: "https://www.downscale.com.au" } : null
      ].filter(Boolean) : [
        { text: "Explore Plans", url: "https://downscaleai.com/plans" },
        user.isAustralian ? { text: "Downscale Clinics (AU)", url: "https://www.downscale.com.au" } : null
      ].filter(Boolean);
    }

    return new Response(JSON.stringify({
      response: reply,
      buttons,
      upgradeSuggested: buttons.length > 0
    }), { headers: corsHeaders });
  }
};
