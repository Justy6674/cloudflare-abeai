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
    return []; // Return empty array on error to prevent breaking the flow
  }
}

async function saveHistory(user_id, message, env) {
  try {
    const history = await getHistory(user_id, env);
    history.push(message);
    await env.ABEAI_KV.put(`history:${user_id}`, JSON.stringify(history.slice(-10))); // Limit history to 10 entries
    console.log(`Saved history for user ${user_id}:`, history);
    return true;
  } catch (err) {
    console.error(`Failed to save history for user ${user_id} to KV:`, err.message);
    return false; // Return false to indicate failure but don't throw error
  }
}

function buildPrompt({ message, context, history }) {
  const { allergies = [], fitnessLevel = "beginner", motivationLevel = "moderate", isAustralian = false } = context;
  const contextBlock = `User context:\nAllergies: ${allergies.join(", ") || "none"}, Fitness level: ${fitnessLevel}, Motivation: ${motivationLevel}, Is Australian: ${isAustralian}`;
  const historyBlock = `History: ${history.length ? history.join("; ") : "No previous history"}`;

  return [
    { role: "system", content: `${BASE_PROMPT}\n${contextBlock}\n${historyBlock}` },
    { role: "user", content: message }
  ];
}

async function handleAIRequest(prompt, env) {
  try {
    console.log("Sending request to OpenAI with prompt:", JSON.stringify(prompt));
    
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
      const errorData = await openaiRes.json().catch(() => null) || await openaiRes.text();
      console.error(`OpenAI API error (${openaiRes.status}):`, errorData);
      throw new Error(`OpenAI API returned ${openaiRes.status}: ${JSON.stringify(errorData)}`);
    }

    const data = await openaiRes.json();
    console.log("OpenAI response:", JSON.stringify(data));
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
      throw new Error("Invalid OpenAI response format: " + JSON.stringify(data));
    }

    return data.choices[0].message.content;
  } catch (err) {
    console.error("handleAIRequest error:", err);
    throw new Error(`Failed to process AI request: ${err.message}`);
  }
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    // Ensure request is POST
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ 
        response: "Method not allowed", 
        debug: "Only POST requests are supported" 
      }), {
        status: 405,
        headers: { 
          "Content-Type": "application/json", 
          "Access-Control-Allow-Origin": "*" 
        }
      });
    }

    // Parse the request JSON
    const parsed = await parseJSON(request);
    if (parsed.error) {
      return new Response(JSON.stringify({ 
        response: "I couldn't understand that request. Could you try again?", 
        debug: parsed.message 
      }), {
        status: 400,
        headers: { 
          "Content-Type": "application/json", 
          "Access-Control-Allow-Origin": "*" 
        }
      });
    }

    const { message, user_id, subscription_tier = "PAYG", user_context = {} } = parsed;

    // Validate required fields
    if (!message || !user_id) {
      return new Response(JSON.stringify({ 
        response: "I need both a message and user ID to help you properly.", 
        debug: "Missing 'message' or 'user_id' field" 
      }), {
        status: 400,
        headers: { 
          "Content-Type": "application/json", 
          "Access-Control-Allow-Origin": "*" 
        }
      });
    }

    try {
      // Log the incoming request for debugging
      console.log("Request:", { 
        message, 
        user_id, 
        subscription_tier, 
        user_context 
      });
      
      // Fetch and update user history using Cloudflare KV
      const historySaved = await saveHistory(user_id, message, env);
      if (!historySaved) {
        console.warn(`Failed to save history for user ${user_id}, continuing anyway`);
      }
      
      const history = await getHistory(user_id, env);
      console.log(`Retrieved history for user ${user_id}:`, history);

      // Build the prompt with user context and history
      const prompt = buildPrompt({ 
        message, 
        context: user_context || {}, 
        history: history || [] 
      });
      console.log("Built prompt:", JSON.stringify(prompt));

      // Call OpenAI for response
      let response = await handleAIRequest(prompt, env);
      console.log("AI response:", response);

      // Add Australian-specific handling
      const upgradeSuggested = subscription_tier !== "Premium";
      if (user_context && user_context.isAustralian) {
        if (upgradeSuggested) {
          response += `\n\n[PT] Para suporte personalizado, acesse www.downscale.com.au.\n[EN] For personalized support, visit www.downscale.com.au.`;
          response += `\n\n[Link Button] <a href="https://www.downscale.com.au" target="_blank">Explore Subscription Options</a>`;
        }
        // Simulate PT (Portuguese) as the first language
        response = `[PT] Olá! ${response}`;
      }

      // Ensure the response is a valid JSON object
      const responseBody = { 
        response, 
        upgrade_suggested: upgradeSuggested 
      };
      console.log("Final response body:", JSON.stringify(responseBody));

      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 
          "Content-Type": "application/json", 
          "Access-Control-Allow-Origin": "*" 
        }
      });
    } catch (err) {
      console.error("Worker error:", err.message, err.stack);
      return new Response(JSON.stringify({ 
        response: "I'm having trouble processing that right now. Let me try to help another way—could you rephrase your question?", 
        debug: err.message,
        stack: err.stack 
      }), {
        status: 500,
        headers: { 
          "Content-Type": "application/json", 
          "Access-Control-Allow-Origin": "*" 
        }
      });
    }
  }
};
