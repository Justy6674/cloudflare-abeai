// ✅ AbeAI Cloudflare Worker – Smart, AI-powered fallback + Supabase support
// Handles monetization triggers, OpenAI fallback, allergy-aware tone, and routing

const SUPABASE_FUNCTION_URL = "https://ekfpageqwbwvwbcoudig.supabase.co/functions/v1/send-message";

const MONETIZATION_TRIGGERS = [
  {
    keywords: ["snack", "meal", "protein", "recipe", "diet", "lunchbox", "takeaway", "food"],
    response: "Here are some quick high-protein snack ideas:\n1. Greek yogurt with berries\n2. Edamame\n3. Cheese & whole grain crackers.\nFor meal plans and personalised recipes, upgrade to Essentials.",
    tier: "Essentials",
    category: "nutrition"
  },
  {
    keywords: ["exercise", "workout", "gym", "walk", "fitness", "activity", "movement"],
    response: "Here’s a starter workout plan:\n• 10 squats\n• 10 pushups\n• 30 sec plank\nUpgrade to Essentials for a personalised weekly plan.",
    tier: "Essentials",
    category: "activity"
  },
  {
    keywords: ["water", "hydration", "fluid", "drink"],
    response: "Staying hydrated is vital. Aim for 2–3L water daily.\nPremium offers hydration tracking and reminders.",
    tier: "Premium",
    category: "hydration"
  },
  {
    keywords: ["mounjaro", "ozempic", "wegovy", "medication", "phentermine", "saxenda"],
    response: "Weight loss medications require supervision.\nFor clinical guidance in Australia, visit https://www.downscale.com.au or consult your GP.\nOur Premium tier includes private medication support.",
    tier: "Premium",
    category: "medication"
  },
  {
    keywords: ["depression", "sleep", "mental", "mood", "anxiety", "stress"],
    response: "Mental health is central to wellness.\nI’m here to support you. For structured emotional coaching, consider Premium.",
    tier: "Premium",
    category: "mental_health"
  }
];

function detectTriggerCategory(message) {
  const lower = message.toLowerCase();
  for (const trigger of MONETIZATION_TRIGGERS) {
    if (trigger.keywords.some(keyword => lower.includes(keyword))) {
      return trigger;
    }
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
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
      const bodyText = await request.text();
      const body = JSON.parse(bodyText);

      const { message, user_id = null, subscription_tier = "PAYG", allergies = [] } = body;
      if (!message) throw new Error("Message missing");

      const trigger = detectTriggerCategory(message);

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
            "Authorization": `Bearer ${env.OPENAI_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "gpt-3.5-turbo",
            messages: [
              {
                role: "system",
                content: `You are AbeAI, a friendly, supportive Australian health coach. Be kind, use evidence-based guidelines. If asked about clinics, refer users to https://www.downscale.com.au. If helpful, refer to https://www.worldobesity.org.`
              },
              { role: "user", content: message }
            ]
          })
        });

        const aiData = await openaiRes.json();
        const reply = aiData?.choices?.[0]?.message?.content || "I'm here to help you, whenever you're ready.";

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
        response: "Sorry, I couldn’t process that right now.",
        debug: err.message
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};
