const SUPABASE_FUNCTION_URL = "https://ekfpageqwbwvwbcoudig.supabase.co/functions/v1/send-message";

const MONETIZATION_TRIGGERS = {
  nutrition: {
    keywords: ["snack", "meal", "protein", "recipe", "food"],
    response: `Here are a few high-protein snack ideas:\n1. Greek yogurt with berries\n2. Boiled eggs\n3. Edamame with sea salt\n\nTo unlock full nutrition plans, upgrade to Essentials or Premium.`,
    tier_required: "Essentials"
  },
  activity: {
    keywords: ["workout", "exercise", "gym", "walk"],
    response: `Try this movement routine:\n1. 10 squats\n2. 10 pushups\n3. 30 sec plank\n\nUpgrade to Essentials for a full weekly training plan.`,
    tier_required: "Essentials"
  },
  hydration: {
    keywords: ["water", "hydration", "drink"],
    response: `Most adults benefit from 2–3L of water daily.\nTrack hydration and get reminders by upgrading to Premium.`,
    tier_required: "Premium"
  }
};

function detectTrigger(message) {
  const lower = message.toLowerCase();
  for (const [_, trigger] of Object.entries(MONETIZATION_TRIGGERS)) {
    if (trigger.keywords.some(keyword => lower.includes(keyword))) {
      return trigger;
    }
  }
  return null;
}

async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey"
      }
    });
  }

  try {
    const body = await request.json();
    const { message, user_id = null, subscription_tier = "PAYG", allergies = [] } = body;

    if (!message) throw new Error("Message missing from request.");

    const trigger = detectTrigger(message);

    if (!user_id || subscription_tier === "PAYG") {
      if (trigger) {
        return new Response(JSON.stringify({
          response: trigger.response,
          upgrade_suggested: true
        }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${await env.OPENAI_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "system",
              content: `You are AbeAI, a supportive, gentle weight loss coach.\nUse evidence-based recommendations.\nSpeak respectfully. Respect user allergies: ${allergies.join(", ")}`
            },
            { role: "user", content: message }
          ]
        })
      });

      const data = await openaiRes.json();
      const reply = data?.choices?.[0]?.message?.content || "I'm here to help you, whenever you're ready.";

      return new Response(JSON.stringify({ response: reply }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const supabaseRes = await fetch(SUPABASE_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": request.headers.get("Authorization"),
        "apikey": request.headers.get("apikey")
      },
      body: JSON.stringify(body)
    });

    const json = await supabaseRes.json();
    return new Response(JSON.stringify({
      response: json.response || "I’m here to support you.",
      upgrade_suggested: json.upgrade_suggested || false
    }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });

  } catch (err) {
    return new Response(JSON.stringify({
      response: "Sorry, I couldn't process that right now.",
      debug: err.message
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};