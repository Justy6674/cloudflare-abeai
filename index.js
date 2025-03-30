// AbeAI Cloudflare Worker - abeai-proxy (Chatbot Backend)
export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://abeai.health",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Content-Type": "application/json"
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Only allow POST
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ response: "Method not allowed" }), {
        status: 405,
        headers: corsHeaders
      });
    }

    // Parse request JSON
    const parsed = await parseJSON(request);
    if (parsed.error) {
      return new Response(JSON.stringify({ response: "Invalid JSON format", debug: parsed.message }), {
        status: 400,
        headers: corsHeaders
      });
    }

    const { message, user_id, subscription_tier = "free" } = parsed;
    if (!message || !user_id) {
      return new Response(JSON.stringify({ response: "Missing 'message' or 'user_id'" }), {
        status: 400,
        headers: corsHeaders
      });
    }

    try {
      console.log("Request received:", { user_id, messageLength: message.length, tier: subscription_tier });

      // Validate environment
      if (!env.ABEAI_KV) throw new Error("ABEAI_KV not bound");
      if (!env.OPENAI_KEY) throw new Error("OPENAI_KEY not set");

      // User context from KV
      const userKey = `user:${user_id}`;
      let context = await env.ABEAI_KV.get(userKey, { type: "json" }) || {
        tier: subscription_tier.toLowerCase(),
        responseCount: 0,
        history: [],
        safetyFlags: {},
        awaitingSafety: null,
        pendingUserQuestion: null,
        lastSafetyPrompt: null,
        isAustralian: request.cf?.country === "AU"
      };

      const saveContext = async () => await env.ABEAI_KV.put(userKey, JSON.stringify(context));
      const messageLower = message.toLowerCase();

      // Safety Checks
      if (suicideIndicators.some(ind => messageLower.includes(ind))) {
        return new Response(JSON.stringify({
          response: "I’m so sorry you’re feeling this way. Call Lifeline at 13 11 14 (AU) or talk to someone you trust. You’re not alone.",
          buttons: [],
          upgradeSuggested: false
        }), { status: 200, headers: corsHeaders });
      }

      const minorMatch = messageLower.match(/\b(i\s*am|i'm)\s*(\d{1,2})\s*(years?\s*old|y\/?o)\b/);
      if (minorMatch && parseInt(minorMatch[2]) < 18) {
        return new Response(JSON.stringify({
          response: "Sorry, I can’t assist minors. Please consult a parent or doctor.",
          buttons: [],
          upgradeSuggested: false
        }), { status: 200, headers: corsHeaders });
      }

      if (disorderedIndicators.some(ind => messageLower.includes(ind))) {
        return new Response(JSON.stringify({
          response: "That’s unsafe. Please see a doctor for healthy options. You deserve to feel good.",
          buttons: [],
          upgradeSuggested: false
        }), { status: 200, headers: corsHeaders });
      }

      // Handle Safety Response
      if (context.awaitingSafety) {
        const pillar = context.awaitingSafety;
        context.safetyFlags[pillar] = message;
        context.awaitingSafety = null;
        const originalQuestion = context.pendingUserQuestion;
        context.pendingUserQuestion = null;

        if (context.lastSafetyPrompt) {
          context.history.push({ role: "assistant", content: context.lastSafetyPrompt });
        }
        context.history.push({ role: "user", content: message });

        const messages = buildPrompt(originalQuestion, context, pillar);
        const aiResponse = await handleAIRequest(messages, env);
        const augmentedReply = appendDiaryPrompt(aiResponse, pillar, context.tier);
        if (context.tier === "free") context.responseCount += 1;
        context.history.push({ role: "assistant", content: aiResponse });
        await saveContext();

        return new Response(JSON.stringify({
          response: augmentedReply,
          buttons: [],
          upgradeSuggested: false
        }), { status: 200, headers: corsHeaders });
      }

      // Pillar Detection
      const detectedPillar = detectHealthPillar(messageLower);
      if (detectedPillar && !context.safetyFlags[detectedPillar]) {
        const safetyPrompt = generateSafetyPrompt(detectedPillar);
        context.awaitingSafety = detectedPillar;
        context.pendingUserQuestion = message;
        context.history.push({ role: "user", content: message });
        context.lastSafetyPrompt = safetyPrompt;
        await saveContext();
        return new Response(JSON.stringify({
          response: safetyPrompt,
          buttons: [],
          upgradeSuggested: false
        }), { status: 200, headers: corsHeaders });
      }

      // Adolescent Check
      const adolescentMatch = messageLower.match(/\bmy\s+(\d{1,2})\s*-?\s*year\s*-?\s*old\b/) || 
                             messageLower.includes("my teen") || 
                             messageLower.includes("my teenager");
      if (adolescentMatch && context.tier !== "premium" && context.tier !== "clinical") {
        const buttons = [
          { label: "Upgrade to Premium", url: "https://downscaleai.com/premium" },
          ...(context.isAustralian ? [
            { label: "Clinical (AU)", url: "https://downscaleai.com/clinical" },
            { label: "Book Downscale", url: "https://www.downscale.com.au" }
          ] : [])
        ];
        return new Response(JSON.stringify({
          response: "For teen guidance, upgrade to Premium or consult a pediatrician.",
          buttons,
          upgradeSuggested: true
        }), { status: 200, headers: corsHeaders });
      }

      // Additional Triggers
      const triggers = {
        medication: {
          keywords: ["ozempic", "wegovy", "mounjaro", "saxenda", "zepbound", "glp-1", "injection"],
          response: "Medication support requires Clinical tier.",
          upsell: { label: "Clinical Support", url: "https://downscaleai.com/clinical" }
        },
        diary: {
          keywords: ["log", "track", "diary", "meal", "hydration", "mood", "activity", "sleep"],
          response: "Tracking features are in Premium.",
          upsell: { label: "Premium Tracking", url: "https://downscaleai.com/premium" }
        }
      };
      let activeTrigger = null;
      for (const [trigger, { keywords }] of Object.entries(triggers)) {
        if (keywords.some(kw => messageLower.includes(kw))) {
          activeTrigger = trigger;
          break;
        }
      }
      if (activeTrigger && context.tier === "free") {
        const buttons = [
          triggers[activeTrigger].upsell,
          ...(context.isAustralian ? [{ label: "Book Downscale (AU)", url: "https://www.downscale.com.au" }] : [])
        ];
        return new Response(JSON.stringify({
          response: triggers[activeTrigger].response,
          buttons,
          upgradeSuggested: true
        }), { status: 200, headers: corsHeaders });
      }

      // Monetization Check
      if (context.tier === "free" && context.responseCount >= 3) {
        const buttons = [
          { label: "PAYG", url: "https://downscaleai.com/payg" },
          { label: "Essentials", url: "https://downscaleai.com/essentials" },
          { label: "Premium", url: "https://downscaleai.com/premium" },
          { label: "Clinical (AU)", url: "https://downscaleai.com/clinical" },
          ...(context.isAustralian ? [{ label: "Book Downscale", url: "https://www.downscale.com.au" }] : [])
        ];
        return new Response(JSON.stringify({
          response: "You’ve hit the free limit. Upgrade for more!",
          buttons,
          upgradeSuggested: true
        }), { status: 200, headers: corsHeaders });
      }

      // AI Request
      const messages = buildPrompt(message, context, detectedPillar);
      const aiResponse = await handleAIRequest(messages, env);
      const augmentedReply = appendDiaryPrompt(aiResponse, detectedPillar, context.tier);
      if (context.tier === "free") context.responseCount += 1;
      context.history.push({ role: "user", content: message }, { role: "assistant", content: aiResponse });
      await saveContext();

      return new Response(JSON.stringify({
        response: augmentedReply,
        buttons: [],
        upgradeSuggested: false
      }), { status: 200, headers: corsHeaders });

    } catch (err) {
      console.error("Worker error:", err.message);
      return new Response(JSON.stringify({
        response: "Sorry, I’m having trouble. Try again soon.",
        debug: { error: err.message }
      }), { status: 500, headers: corsHeaders });
    }
  }
};

// Helpers
async function parseJSON(request) {
  try {
    const text = await request.text();
    return JSON.parse(text);
  } catch (err) {
    return { error: true, message: "Invalid JSON: " + err.message };
  }
}

const suicideIndicators = ["suicide", "kill myself", "end my life", "die by suicide", "want to die"];
const disorderedIndicators = ["vomit", "purge", "laxative", "starve", "not eat anything", "only water fast", "self-harm"];

function detectHealthPillar(message) {
  const keywords = {
    clinical: ["medication", "doctor", "clinic", "condition", "insulin", "thyroid", "bariatric", "metabolism"],
    nutrition: ["diet", "meal", "food", "calorie", "protein", "fasting", "nutrition"],
    activity: ["exercise", "workout", "run", "walk", "yoga", "steps", "gym"],
    mental: ["stress", "anxiety", "depress", "mood", "mental", "sleep", "binge"]
  };
  for (const [pillar, words] of Object.entries(keywords)) {
    if (words.some(kw => message.includes(kw))) return pillar;
  }
  return null;
}

function generateSafetyPrompt(pillar) {
  const prompts = {
    clinical: "Do you have any medical conditions or medications?",
    nutrition: "Any allergies or dietary restrictions?",
    activity: "Any injuries or conditions affecting activity?",
    mental: "Are you under significant stress or receiving mental health support?"
  };
  return prompts[pillar] || "Any health concerns to note?";
}

function buildPrompt(message, context, pillar) {
  const basePrompt = `You are AbeAI, an Australian weight-loss coach. Use Australian English (e.g., 'fibre', 'metre') and cultural references (e.g., Vegemite, Woolworths) where relevant. Be warm, non-judgmental, and motivational, aligning with Maslow’s hierarchy. Focus on safety and the four pillars: Clinical, Nutrition, Activity, Mental Health. Current pillar: ${pillar || "general"}. Context: Allergies: ${context.safetyFlags?.nutrition || "None"}, Conditions: ${context.safetyFlags?.clinical || "None"}, Injuries: ${context.safetyFlags?.activity || "None"}, Mental Health: ${context.safetyFlags?.mental || "None"}. ${context.tier === "free" ? "Keep it concise." : "Be detailed and personalized."} End with a motivating question or diary prompt.`;
  const historyBlock = context.history.length > 0 ? `History: ${context.history.map(m => m.content).join("; ")}` : "No previous interactions";

  return [
    { role: "system", content: `${basePrompt}\n\n${historyBlock}` },
    ...context.history.slice(-6),
    { role: "user", content: message }
  ];
}

function appendDiaryPrompt(replyText, pillar, tier) {
  const prompts = {
    nutrition: " Want to log this meal?",
    activity: " Want to log this activity?",
    mental: " Want to track your mood?",
    clinical: tier === "clinical" ? " Want to log your medication?" : ""
  };
  return replyText + (prompts[pillar] || " How can I help you next?");
}

async function handleAIRequest(promptMessages, env) {
  const openaiUrl = "https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/v1/chat/completions";
  const response = await fetch(openaiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.OPENAI_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: promptMessages,
      temperature: 0.7,
      max_tokens: promptMessages[0].content.includes("free") ? 200 : 500
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("OpenAI API error:", response.status, errText);
    throw new Error(`OpenAI API failed: ${errText}`);
  }

  const data = await response.json();
  console.log("OpenAI tokens used:", data.usage?.total_tokens);
  return data.choices?.[0]?.message?.content || "No response generated.";
}
