// AbeAI Comprehensive Backend for Cloudflare Workers
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
      return new Response("Only POST method allowed", { status: 405, headers: corsHeaders });
    }

    const req = await request.json();
    const { user_id, message, contextUpdate } = req;

    if (!user_id || !message) {
      return new Response("Missing user_id or message", { status: 400, headers: corsHeaders });
    }

    // Fetch user data from KV
    let user = await env.ABEAI_KV.get(`user:${user_id}`, "json");
    if (!user) {
      user = { tier: "free", history: [], context: {}, freeResponseCount: 0 };
    }

    // Update context if provided (e.g., allergies, injuries, meds)
    if (contextUpdate) {
      user.context = { ...user.context, ...contextUpdate };
    }

    // Define pillars and their keywords explicitly
    const pillars = {
      clinical: ["bmi", "insulin", "medication", "bariatric", "thyroid", "metabolism"],
      nutrition: ["snack", "meal", "protein", "recipe", "diet", "carb", "fasting", "calorie"],
      activity: ["exercise", "workout", "steps", "fitness", "yoga", "running"],
      mental: ["stress", "sleep", "motivation", "anxiety", "emotional eating", "binge"]
    };

    // Identify active pillar
    let activePillar = null;
    for (const [pillar, keywords] of Object.entries(pillars)) {
      if (keywords.some(kw => message.toLowerCase().includes(kw))) {
        activePillar = pillar;
        break;
      }
    }

    // Safety prompts per pillar
    const safetyPrompts = {
      clinical: "Do you have any medical conditions, or are you currently taking medications?",
      nutrition: "Do you have any allergies or intolerances (e.g., nuts, dairy, gluten)?",
      activity: "Any injuries, joint issues, or medical conditions affecting your physical activity?",
      mental: "Are you experiencing significant stress, anxiety, depression, or receiving mental health treatment?"
    };

    // Ask safety prompt if context missing
    if (activePillar && !user.context[activePillar]) {
      await env.ABEAI_KV.put(`user:${user_id}`, JSON.stringify(user));
      return new Response(JSON.stringify({
        response: safetyPrompts[activePillar],
        requestContext: activePillar
      }), { headers: corsHeaders });
    }

    // Free user response limitation (monetization after 3 free answers)
    if (user.tier === "free" && user.freeResponseCount >= 3) {
      return new Response(JSON.stringify({
        response: "For personalized, ongoing support tailored to your needs, please consider one of our subscription plans:",
        buttons: [
          { text: "PAYG Report", url: "https://downscaleai.com/payg" },
          { text: "Essentials Plan", url: "https://downscaleai.com/essentials" },
          { text: "Premium Plan", url: "https://downscaleai.com/premium" },
          { text: "Clinical Plan (AU)", url: "https://downscaleai.com/clinical" }
        ],
        upgradeSuggested: true
      }), { headers: corsHeaders });
    }

    // Increment free response count
    if (user.tier === "free") user.freeResponseCount += 1;

    // Save updated user data
    await env.ABEAI_KV.put(`user:${user_id}`, JSON.stringify(user));

    // AI Prompt explicitly instructing Australian focus
    const systemPrompt = `
      You are AbeAI, a clinical-grade, empathetic health coach for obesity management following worldobesity.org's PT-first guidelines. 
      Strictly respond using Australian English, referencing culturally relevant foods (e.g., Vegemite, kangaroo meat, Tim Tams), Australian supermarkets (Coles, Woolworths), and common local takeaways.
      Explicitly consider user's provided context:
      Allergies: ${user.context.nutrition || "None"}
      Injuries: ${user.context.activity || "None"}
      Medications/Clinical conditions: ${user.context.clinical || "None"}
      Mental Health context: ${user.context.mental || "None"}
      Always end responses with engaging follow-up questions to encourage healthy behaviors and ongoing interaction.
    `;

    // Call OpenAI API
    const openaiRes = await fetch("https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ],
        temperature: 0.6,
        max_tokens: user.tier === "Premium" || user.tier === "Clinical" ? 500 : 200
      })
    });

    const aiResponse = await openaiRes.json();
    const reply = aiResponse.choices[0].message.content;

    // Prepare upsell if free or PAYG
    let buttons = [];
    if (user.tier === "free" || user.tier === "PAYG") {
      buttons = [
        { text: "Essentials Plan", url: "https://downscaleai.com/essentials" },
        { text: "Premium Plan", url: "https://downscaleai.com/premium" },
        { text: "Clinical Plan (AU)", url: "https://downscaleai.com/clinical" }
      ];
    }

    return new Response(JSON.stringify({
      response: reply,
      buttons,
      upgradeSuggested: buttons.length > 0
    }), { headers: corsHeaders });
  }
};
