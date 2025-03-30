// AbeAI Comprehensive Clinical-Grade Backend
export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (request.method !== "POST") return new Response("POST only", { status: 405, headers: corsHeaders });

    const { user_id, message, safetyInfo } = await request.json();
    if (!user_id || !message) return new Response("Missing user_id or message", { status: 400, headers: corsHeaders });

    // Fetch User Data
    let user = await env.ABEAI_KV.get(`user:${user_id}`, "json");
    if (!user) user = { tier: "free", context: {}, history: [] };

    // Save helper
    const saveUser = async () => await env.ABEAI_KV.put(`user:${user_id}`, JSON.stringify(user));

    const msg = message.toLowerCase();

    // Pillar-based triggers and safety prompts
    const pillars = {
      clinical: {
        triggers: ["bmi", "insulin", "thyroid", "bariatric", "medication", "weight loss", "plateau", "metabolism"],
        safety: "Could you briefly tell me if you're currently on medications, have any medical conditions, or recent surgeries?",
        contextKey: "clinicalSafety",
        upsell: {text: "Clinical Support", url: "https://downscaleai.com/clinical"}
      },
      nutrition: {
        triggers: ["snack", "meal", "recipe", "protein", "carbs", "diet", "fasting", "belly fat"],
        safety: "Do you have any allergies or intolerances (e.g., nuts, gluten, dairy, seafood)?",
        contextKey: "allergies",
        upsell: {text: "Essentials Nutrition", url: "https://downscaleai.com/essentials"}
      },
      activity: {
        triggers: ["exercise", "workout", "steps", "heart rate", "yoga", "pain", "knees", "activity"],
        safety: "Any injuries, joint pain, or medical conditions that limit your activity?",
        contextKey: "injuries",
        upsell: {text: "Premium Activity Plan", url: "https://downscaleai.com/premium"}
      },
      mental: {
        triggers: ["stress", "binge", "emotional eating", "self-esteem", "sleep", "motivation"],
        safety: "Are you experiencing stress, anxiety, depression, or are you receiving any mental health treatment?",
        contextKey: "mentalHealth",
        upsell: {text: "Mental Health Coaching", url: "https://downscaleai.com/premium"}
      }
    };

    let activePillar = null;
    for (let [key, { triggers }] of Object.entries(pillars)) {
      if (triggers.some(t => msg.includes(t))) {
        activePillar = pillars[key];
        break;
      }
    }

    // Safety check & gather info
    if (activePillar && !user.context[activePillar.contextKey] && !safetyInfo) {
      return new Response(JSON.stringify({
        response: `Thank you for reaching out! To provide safe, personalised support, ${activePillar.safety}`,
        requestSafetyInfo: activePillar.contextKey
      }), { headers: corsHeaders });
    }

    // Store Safety Info
    if (safetyInfo && activePillar) {
      user.context[activePillar.contextKey] = safetyInfo;
      await saveUser();

      return new Response(JSON.stringify({
        response: `Great, thank you for sharing. Based on that, I suggest exploring our tailored ${activePillar.upsell.text}. This includes comprehensive guidance, personalised tracking, and professional support.`,
        upgradeSuggested: true,
        buttons: [activePillar.upsell, {
          text: "Book with Downscale Clinics (AU)",
          url: "https://www.downscale.com.au"
        }]
      }), { headers: corsHeaders });
    }

    // Prompt construction for OpenAI
    const basePrompt = `
      You are AbeAI, a clinically-focused, empathetic, PT-first health coach specialized in obesity management according to worldobesity.org standards. Always address user compassionately, referencing their context:
      - Allergies: ${user.context.allergies || "None"}
      - Injuries: ${user.context.injuries || "None"}
      - Clinical Info: ${user.context.clinicalSafety || "None"}
      - Mental Health: ${user.context.mentalHealth || "None"}
      Always provide safe advice. Encourage users towards healthy behaviours. Conclude with motivating follow-up questions.
    `;

    const aiResponse = await fetch("https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: basePrompt },
          { role: "user", content: message }
        ],
        temperature: 0.6,
        max_tokens: user.tier === "Premium" ? 400 : 200
      })
    });

    const { choices } = await aiResponse.json();
    const reply = choices[0].message.content;

    // Limit free users and encourage monetization
    let responsePayload = { response: reply, upgradeSuggested: user.tier === "free" };
    if (user.tier === "free" && activePillar) {
      responsePayload.response += `\n\nFor deeper insights, personalised plans, and professional tracking, consider upgrading:`;
      responsePayload.buttons = [activePillar.upsell, {
        text: "Visit Downscale Clinics (AU)",
        url: "https://www.downscale.com.au"
      }];
    }

    // Save interaction history (short, 5 interactions max)
    user.history.push({ question: message, response: reply });
    if (user.history.length > 5) user.history.shift();
    await saveUser();

    return new Response(JSON.stringify(responsePayload), { headers: corsHeaders });
  }
};
