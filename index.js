// AbeAI Cloudflare Worker - abeai-proxy (Chatbot Backend)

// Import any necessary libraries (if using modules). In this case, we use no external imports.
// We will define our functions (parseJSON, getHistory, saveHistory, buildPrompt, handleAIRequest) within this file.

// Optional: Base system prompt defining the AI's persona and guidelines.
const BASE_PROMPT = `
You are AbeAI, an empathetic, data-driven health coach. You provide personalized advice on weight loss and healthy living.
Respond in a friendly, concise manner. If asked for medical advice, include a disclaimer.
`;

// Helper 1: Safely parse JSON from request
async function parseJSON(request) {
  try {
    const text = await request.text();
    return JSON.parse(text);
  } catch (err) {
    // Return an object indicating error to differentiate from throwing (we don't want to throw and crash the worker on bad JSON)
    return { error: true, message: "Invalid JSON format: " + err.message };
  }
}

// Helper 2: Retrieve user history from KV (returns an array of past messages)
async function getHistory(user_id, env) {
  if (!user_id) {
    console.warn("Missing user_id in getHistory");
    return [];
  }
  try {
    // Ensure KV binding exists
    if (!env.ABEAI_KV) {
      console.error("ABEAI_KV namespace not bound to worker. Check wrangler.toml configuration.");
      return [];
    }
    const key = `history:${user_id}`;
    const raw = await env.ABEAI_KV.get(key);
    if (!raw) {
      // No history found
      return [];
    }
    // Parse the JSON array
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`Error fetching history for user ${user_id}:`, err.message);
    return []; // Return empty history on any error
  }
}

// Helper 3: Save user message to history in KV (store only last 10 messages)
async function saveHistory(user_id, message, env) {
  if (!user_id || !message) {
    console.warn("Missing user_id or message in saveHistory");
    return false;
  }
  try {
    if (!env.ABEAI_KV) {
      console.error("ABEAI_KV namespace not bound to worker. Check wrangler.toml configuration.");
      return false;
    }
    // Get current history array, append new message
    const history = await getHistory(user_id, env);
    history.push(message);
    // Keep only the last 10 messages to limit history size
    const limitedHistory = history.slice(-10);
    const key = `history:${user_id}`;
    await env.ABEAI_KV.put(key, JSON.stringify(limitedHistory));
    console.log(`Saved history for user ${user_id} (length=${limitedHistory.length})`);
    return true;
  } catch (err) {
    console.error(`Failed to save history for user ${user_id}:`, err.message);
    return false;
  }
}

// Helper 4: Build the prompt array (system + user messages) incorporating context and history
function buildPrompt({ message, context = {}, history = [] }) {
  // Ensure context is an object
  const safeContext = (typeof context === 'object' && context !== null) ? context : {};

  // Process user context fields with safe defaults
  let allergies = [];
  if (Array.isArray(safeContext.allergies)) {
    allergies = safeContext.allergies;
  } else if (safeContext.allergies) {
    // If allergies provided as a single value, convert to array
    allergies = [ String(safeContext.allergies) ];
  }
  const fitnessLevel = (typeof safeContext.fitnessLevel === 'string') 
                        ? safeContext.fitnessLevel 
                        : "beginner";
  const motivationLevel = (typeof safeContext.motivationLevel === 'string') 
                          ? safeContext.motivationLevel 
                          : "moderate";
  const isAustralian = !!safeContext.isAustralian; // boolean

  // Prepare context block text
  const contextBlock = `User context:
Allergies: ${allergies.length > 0 ? allergies.join(", ") : "none"}
Fitness level: ${fitnessLevel}
Motivation: ${motivationLevel}
Is Australian: ${isAustralian}`;

  // Prepare history block text
  let historyBlock;
  if (Array.isArray(history) && history.length > 0) {
    // Join history messages into one string (assuming history is an array of user messages)
    historyBlock = `History: ${history.join("; ")}`;
  } else {
    historyBlock = "History: No previous interactions";
  }

  // Debug logging for context/history (can be removed in production if sensitive)
  console.log("Context block:", contextBlock);
  console.log("History block:", historyBlock);

  // Compose the final prompt as an array of message objects
  const promptMessages = [
    {
      role: "system",
      content: `${BASE_PROMPT}\n\n${contextBlock}\n\n${historyBlock}`
    },
    {
      role: "user",
      content: message
    }
  ];
  return promptMessages;
}

// Helper 5: Send request to OpenAI (via Cloudflare AI Gateway or directly) and get the assistant's response
async function handleAIRequest(promptMessages, env) {
  try {
    // Ensure API key is present
    if (!env.OPENAI_KEY) {
      throw new Error("OpenAI API key is missing. Set it in the Worker secrets.");
    }
    // Construct the fetch URL for OpenAI
    const openaiUrl = "https://gateway.ai.cloudflare.com/v1/ACCOUNT_ID/ABEAI-OPENAI-GATEWAY/openai/v1/chat/completions";
    // (Replace ACCOUNT_ID and ABEAI-OPENAI-GATEWAY with your actual values from Cloudflare AI Gateway)
    // If you want to call OpenAI directly without the gateway, use:
    // const openaiUrl = "https://api.openai.com/v1/chat/completions";

    // Prepare the request payload
    const requestBody = {
      model: "gpt-3.5-turbo",
      messages: promptMessages,
      temperature: 0.7
    };

    // Send POST request to OpenAI API
    const openaiRes = await fetch(openaiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_KEY}`  // OpenAI API key for auth
      },
      body: JSON.stringify(requestBody)
    });

    // Check for HTTP errors from OpenAI
    if (!openaiRes.ok) {
      // Try to extract error details
      let errorDetails;
      try {
        errorDetails = await openaiRes.json();
      } catch {
        errorDetails = await openaiRes.text();
      }
      const status = openaiRes.status;
      console.error(`OpenAI API error (${status}):`, errorDetails);
      // Map specific errors to friendlier messages
      if (status === 401) {
        throw new Error("OpenAI API key is invalid or unauthorized.");
      } else if (status === 429) {
        throw new Error("OpenAI API rate limit exceeded. Please try again later.");
      } else {
        throw new Error(`OpenAI API error ${status}: ${JSON.stringify(errorDetails)}`);
      }
    }

    // Parse successful response
    const data = await openaiRes.json();
    console.log("OpenAI usage (total tokens):", data.usage?.total_tokens || "unknown");
    // Validate response format
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      console.error("Invalid OpenAI response format:", JSON.stringify(data));
      throw new Error("Unexpected response format from OpenAI.");
    }
    // Return the assistant's reply text
    return data.choices[0].message.content;
  } catch (err) {
    // Log and rethrow error to be handled by outer function
    console.error("AI request failed:", err.message);
    throw err;  // propagate the error to be caught by the fetch handler
  }
}

// The Fetch event handler: this is the main entry point for the Worker
export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();  // start timing for performance measurement

    // Define CORS headers to be used in responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",        // allow all origins (or lock this down to your domain if desired)
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"          // cache preflight for 1 day
    };

    // Handle CORS Preflight requests quickly
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Only allow POST for the actual chatbot requests
    if (request.method !== "POST") {
      return new Response(JSON.stringify({
        response: "Method not allowed",
        debug: "Only POST requests are supported"
      }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // Parse request JSON body
    const parsed = await parseJSON(request);
    if (parsed.error) {
      // JSON was malformed
      return new Response(JSON.stringify({
        response: "Invalid request format. Please send JSON.",
        debug: parsed.message  // includes the JSON parse error
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // Extract expected fields from parsed JSON
    const { message, user_id, subscription_tier = "PAYG", user_context = {} } = parsed;
    if (!message || !user_id) {
      return new Response(JSON.stringify({
        response: "Missing 'message' or 'user_id' in request.",
        debug: "Both message and user_id are required."
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    try {
      // Debug log: incoming request info (but not logging full message for privacy)
      console.log("Incoming request", {
        user: user_id,
        messageLength: message.length,
        subscription: subscription_tier
      });

      // Double-check env configuration
      if (!env.ABEAI_KV) {
        console.error("ABEAI_KV namespace not bound. KV operations will be skipped.");
      }
      if (!env.OPENAI_KEY) {
        console.error("OPENAI_KEY not set in environment!");
      }

      // Save the new message to user history (non-blocking, but we await to ensure it's done)
      const saved = await saveHistory(user_id, message, env);
      if (!saved) {
        console.warn(`Could not save history for user ${user_id} (proceeding without persistent history)`);
      }

      // Retrieve recent history from KV (to include in context)
      const history = await getHistory(user_id, env);
      console.log(`History for ${user_id}: ${history.length} items`);

      // Build the prompt for OpenAI using user context and history
      const promptMessages = buildPrompt({ message, context: user_context, history });

      // Call OpenAI API (via AI Gateway or direct) to get a completion
      let aiResponse = await handleAIRequest(promptMessages, env);
      console.log(`AI response received (length=${aiResponse.length} chars)`);

      // Post-process response: decide if we should suggest an upgrade
      const isPremium = subscription_tier === "Premium";
      let upgradeSuggested = false;
      if (!isPremium) {
        upgradeSuggested = true;
        if (user_context.isAustralian) {
          // If user is Australian, append bilingual prompt with Australian-specific link
          aiResponse += "\n\n[PT] Para suporte personalizado, acesse www.downscale.com.au.\n[EN] For personalized support, visit www.downscale.com.au.";
          aiResponse += "\n\n[Link Button] <a href=\"https://www.downscale.com.au\" target=\"_blank\">Explore Subscription Options</a>";
          // Also prepend a greeting in Portuguese for Australian context (as an example of localization)
          aiResponse = "[PT] Olá! " + aiResponse;
        } else {
          // For non-Australian users, suggest the AbeAI upgrade
          aiResponse += "\n\n[Link Button] <a href=\"https://www.abeai.health/pricing\" target=\"_blank\">Upgrade for personalized plans</a>";
        }
      }

      // Prepare the final response object
      const responseBody = {
        response: aiResponse,
        upgrade_suggested: upgradeSuggested,
        debug: {
          user_id: user_id,
          subscription_tier: subscription_tier,
          history_length: history.length,
          is_australian: !!user_context.isAustralian,
          processing_time_ms: Date.now() - startTime
        }
      };

      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });

    } catch (err) {
      // Error handling: log the error and return a friendly message to client
      console.error("Worker error:", err.message);
      const errorResponse = {
        response: "I'm having trouble right now. Please try again in a moment.",
        error: true,
        debug: {
          error_message: err.message,
          time: new Date().toISOString(),
          processing_time_ms: Date.now() - startTime
        }
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }
};
