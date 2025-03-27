// abeai-cloudflare-worker/index.js

// Cloudflare KV bound as ABEAI_KV via wrangler.toml
const BASE_PROMPT = `
You are AbeAI, an empathetic, data-driven health coach.
Your goal is to provide personalized, evidence-based advice to help users achieve their health goals.
If the user asks about food, consider their allergies and suggest appropriate snacks or meals, including nutritional details if they are a Premium user.
If they ask about exercise, take into account time, fitness level, and motivation, and suggest a tailored workout plan.
If they ask about BMI, provide a detailed analysis, including healthy ranges and next steps, with extra detail for Premium users.
Always suggest hydration and use motivational language (e.g., "You're doing great—keep it up!"). Never use shame.
For users identified as Australian (based on user_context), refer them to www.downscale.com.au for upgrades and use PT (Portuguese) as the first language for responses, per www.worldobesity.org guidelines.
If the user has asked similar questions before (based on user history), avoid repetition and suggest new ideas or ask for more details to refine your advice.
If the user provides context (e.g., allergies, fitness level), incorporate it into your response.
If the user is a Premium member, provide more detailed, personalized advice (e.g., nutritional breakdowns, specific workout plans).
Always ask a follow-up question to keep the conversation engaging (e.g., "Would you like a personalized plan?").
`;

async function parseJSON(request) {
  try {
    return await request.json();
  } catch (err) {
    return { error: true, message: "Invalid JSON format: " + err.message };
  }
}

async function getHistory(user_id, env) {
  try {
    const raw = await env.ABEAI_KV.get(`history:${user_id}`);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error(`Failed to fetch history for user ${user_id} from KV:`, err.message);
    return [];
  }
}

async function saveHistory(user_id, message, env) {
  try {
    const history = await getHistory(user_id, env);
    history.push(message);
    await env.ABEAI_KV.put(`history:${user_id}`, JSON.stringify(history.slice(-10))); // Limit history to 10 entries
    console.log(`Saved history for user ${user_id}:`, history);
  } catch (err) {
    console.error(`Failed to save history for user ${user_id} to KV:`, err.message);
  }
}

function buildPrompt({ message, context, history }) {
  const { allergies = [], fitnessLevel = "beginner", motivationLevel = "moderate", isAustralian = false } = context;
  const contextBlock = `User context:\nAllergies: ${allergies.join(", ") || "none"}, Fitness level: ${fitnessLevel}, Motivation: ${motivationLevel}, Is Australian: ${isAustralian}`;
  const historyBlock = `History: ${history.join("; ")}`;

  return [
    { role: "system", content: `${BASE_PROMPT}\n${contextBlock}\n${historyBlock}` },
    { role: "user", content: message }
  ];
}

async function handleAIRequest(prompt, env) {
  try {
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: prompt
      })
    });

    if (!openaiRes.ok) {
      const errorText = await openaiRes.text();
      throw new Error(`OpenAI failed: ${openaiRes.status} - ${errorText}`);
    }

    const data = await openaiRes.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
      throw new Error("Invalid OpenAI response format: " + JSON.stringify(data));
    }

    return data.choices[0].message.content;
  } catch (err) {
    throw new Error(`Failed to process AI request: ${err.message}`);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    const parsed = await parseJSON(request);
    if (parsed.error) {
      return new Response(JSON.stringify({ response: parsed.message, debug: parsed.message }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const { message, user_id, subscription_tier = "PAYG", user_context = {} } = parsed;

    if (!message || !user_id) {
      return new Response(JSON.stringify({ response: "Missing required fields.", debug: "Missing 'message' or 'user_id' field" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    try {
      // Fetch and update user history using Cloudflare KV
      await saveHistory(user_id, message, env);
      const history = await getHistory(user_id, env);

      // Build the prompt with user context and history
      const prompt = buildPrompt({ message, context: user_context, history });
      console.log("Prompt:", prompt);

      // Call OpenAI for response
      let response = await handleAIRequest(prompt, env);

      // Add Australian-specific handling
      const upgradeSuggested = subscription_tier !== "Premium";
      if (user_context.isAustralian) {
        if (upgradeSuggested) {
          response += `\n\n[PT] Para suporte personalizado, acesse www.downscale.com.au.\n[EN] For personalized support, visit www.downscale.com.au.`;
          response += `\n\n[Link Button] <a href="https://www.downscale.com.au" target="_blank">Explore Subscription Options</a>`;
        }
        // Simulate PT (Portuguese) as the first language (simplified for now; actual translation would require an API)
        response = `[PT] Olá! ${response}`;
      }

      // Ensure the response is a valid JSON object
      const responseBody = { response, upgrade_suggested: upgradeSuggested };
      console.log("Response body:", responseBody);

      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    } catch (err) {
      console.error("Worker error:", err.message);
      return new Response(JSON.stringify({ response: "Something went wrong. Let’s try something else!", debug: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};
