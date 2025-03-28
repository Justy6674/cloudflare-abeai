// abeai-cloudflare-worker/index.js - FINAL VERSION

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

// Parse JSON with error handling
async function parseJSON(request) {
  try {
    return await request.json();
  } catch (err) {
    return { error: true, message: "Invalid JSON format: " + err.message };
  }
}

// Get user history from KV with robust error handling
async function getHistory(user_id, env) {
  if (!user_id) {
    console.warn("Missing user_id in getHistory");
    return [];
  }

  try {
    // Verify KV binding
    if (!env.ABEAI_KV) {
      console.error("ABEAI_KV namespace not bound to worker. Check wrangler.toml configuration.");
      return []; // Return empty array to continue the flow
    }

    const key = `history:${user_id}`;
    console.log(`Fetching history for user ${user_id} with key ${key}`);
    
    const raw = await env.ABEAI_KV.get(key);
    
    if (!raw) {
      console.log(`No history found for user ${user_id}`);
      return [];
    }
    
    try {
      const parsed = JSON.parse(raw);
      console.log(`Retrieved ${parsed.length} history items for user ${user_id}`);
      return Array.isArray(parsed) ? parsed : [];
    } catch (parseErr) {
      console.error(`Failed to parse history JSON for user ${user_id}:`, parseErr);
      return [];
    }
  } catch (err) {
    console.error(`Error fetching history for user ${user_id}:`, err.message);
    return []; // Return empty array on error to prevent breaking the flow
  }
}

// Save user history to KV with robust error handling
async function saveHistory(user_id, message, env) {
  if (!user_id || !message) {
    console.warn("Missing user_id or message in saveHistory");
    return false;
  }

  try {
    // Verify KV binding
    if (!env.ABEAI_KV) {
      console.error("ABEAI_KV namespace not bound to worker. Check wrangler.toml configuration.");
      return false;
    }
    
    // Get existing history
    const history = await getHistory(user_id, env);
    
    // Add new message and limit to last 10
    history.push(message);
    const limitedHistory = history.slice(-10);
    
    // Save to KV
    const key = `history:${user_id}`;
    await env.ABEAI_KV.put(key, JSON.stringify(limitedHistory));
    
    console.log(`Saved ${limitedHistory.length} history items for user ${user_id}`);
    return true;
  } catch (err) {
    console.error(`Failed to save history for user ${user_id}:`, err.message);
    return false;
  }
}

// Build prompt with robust type checking and formatting
function buildPrompt({ message, context, history }) {
  // Safe handling of context with defaults
  const safeContext = typeof context === 'object' && context !== null ? context : {};
  
  // Handle allergies safely
  let allergies = [];
  if (Array.isArray(safeContext.allergies)) {
    allergies = safeContext.allergies;
  } else if (safeContext.allergies) {
    try {
      // Try to handle if allergies was passed as a string
      allergies = [safeContext.allergies.toString()];
    } catch (e) {
      console.warn("Could not process allergies:", e);
    }
  }
  
  // Handle other context fields with defaults
  const fitnessLevel = typeof safeContext.fitnessLevel === 'string' ? safeContext.fitnessLevel : "beginner";
  const motivationLevel = typeof safeContext.motivationLevel === 'string' ? safeContext.motivationLevel : "moderate";
  const isAustralian = !!safeContext.isAustralian;
  
  // Safely handle history
  const safeHistory = Array.isArray(history) ? history : [];
  
  // Build context block with properly formatted data
  const contextBlock = `User context:
Allergies: ${allergies.length > 0 ? allergies.join(", ") : "none"}
Fitness level: ${fitnessLevel}
Motivation: ${motivationLevel}
Is Australian: ${isAustralian}`;

  // Build history block
  const historyBlock = safeHistory.length > 0 
    ? `History: ${safeHistory.join("; ")}`
    : "History: No previous interactions";

  // Log the constructed blocks for debugging
  console.log("Context block:", contextBlock);
  console.log("History block:", historyBlock);

  // Return the complete prompt
  return [
    { 
      role: "system", 
      content: `${BASE_PROMPT}\n\n${contextBlock}\n\n${historyBlock}` 
    },
    { 
      role: "user", 
      content: message 
    }
  ];
}

// Handle OpenAI API request with comprehensive error handling
async function handleAIRequest(prompt, env) {
  try {
    // Log prompt structure for debugging (without full content for privacy)
    console.log("Sending request to OpenAI with prompt structure:", 
      JSON.stringify(prompt.map(msg => ({role: msg.role, contentLength: msg.content.length}))));
    
    // Verify OpenAI API key exists
    if (!env.OPENAI_KEY) {
      throw new Error("OpenAI API key is missing. Set it with 'wrangler secret put OPENAI_KEY'");
    }
    
    // Make request to OpenAI API via AI Gateway
    const openaiRes = await fetch("https://gateway.ai.cloudflare.com/v1/d9cc7ec108df8e78246e2553ae88c6c2/abeai-openai-gateway/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: prompt,
        temperature: 0.7
      })
    });

    // Handle HTTP errors
    if (!openaiRes.ok) {
      let errorText;
      try {
        const errorJson = await openaiRes.json();
        errorText = JSON.stringify(errorJson);
      } catch (e) {
        errorText = await openaiRes.text();
      }
      
      console.error(`OpenAI API error (${openaiRes.status}): ${errorText}`);
      
      // Provide specific error messages for common issues
      if (openaiRes.status === 401) {
        throw new Error("OpenAI API key is invalid. Check your OPENAI_KEY in Cloudflare secrets.");
      } else if (openaiRes.status === 429) {
        throw new Error("OpenAI API rate limit exceeded. Try again later or upgrade your plan.");
      } else {
        throw new Error(`OpenAI API error: ${openaiRes.status} - ${errorText}`);
      }
    }

    // Parse response
    const data = await openaiRes.json();
    console.log("OpenAI response received with tokens:", data.usage?.total_tokens || "unknown");
    
    // Validate response format
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      console.error("Invalid OpenAI response format:", JSON.stringify(data));
      throw new Error("Invalid response format from OpenAI API");
    }

    return data.choices[0].message.content;
  } catch (err) {
    console.error("AI request failed:", err.message, err.stack);
    throw new Error(`AI request failed: ${err.message}`);
  }
}

// Main worker export
export default {
  async fetch(request, env) {
    // Start timing for performance tracking
    const startTime = Date.now();

    // Define CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", // Allow requests from any origin
      "Access-Control-Allow-Methods": "POST, OPTIONS", // Allow POST and OPTIONS methods
      "Access-Control-Allow-Headers": "Content-Type", // Allow Content-Type header
      "Access-Control-Max-Age": "86400" // Cache preflight response for 24 hours
    };

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204, // No Content
        headers: corsHeaders
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
          ...corsHeaders
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
          ...corsHeaders
        }
      });
    }

    // Extract and validate request fields
    const { message, user_id, subscription_tier = "PAYG", user_context = {} } = parsed;

    if (!message || !user_id) {
      return new Response(JSON.stringify({ 
        response: "I need both a message and user ID to help you properly.", 
        debug: "Missing 'message' or 'user_id' field" 
      }), {
        status: 400,
        headers: { 
          "Content-Type": "application/json", 
          ...corsHeaders
        }
      });
    }

    try {
      // Log the incoming request for debugging (without full message for privacy)
      console.log("Request:", { 
        messageLength: message.length,
        user_id, 
        subscription_tier, 
        user_context: JSON.stringify(user_context)
      });
      
      // Verify environment configuration
      if (!env.ABEAI_KV) {
        console.error("ABEAI_KV namespace not bound. Check wrangler.toml configuration.");
      }
      
      if (!env.OPENAI_KEY) {
        console.error("OPENAI_KEY not found. Set it with 'wrangler secret put OPENAI_KEY'");
      }
      
      // Save message to history
      const historySaved = await saveHistory(user_id, message, env);
      if (!historySaved) {
        console.warn(`Failed to save history for user ${user_id}, continuing anyway`);
      }
      
      // Get user history
      const history = await getHistory(user_id, env);
      console.log(`Retrieved ${history.length} history items for user ${user_id}`);

      // Build the prompt
      const prompt = buildPrompt({ 
        message, 
        context: user_context, 
        history
      });
      
      // Get AI response
      let response = await handleAIRequest(prompt, env);
      console.log("AI response received, length:", response.length);

      // Apply Australian-specific handling if needed
      const upgradeSuggested = subscription_tier !== "Premium";
      if (user_context && user_context.isAustralian) {
        if (upgradeSuggested) {
          response += `\n\n[PT] Para suporte personalizado, acesse www.downscale.com.au.\n[EN] For personalized support, visit www.downscale.com.au.`;
          response += `\n\n[Link Button] <a href="https://www.downscale.com.au" target="_blank">Explore Subscription Options</a>`;
        }
        // Prepend Portuguese greeting
        response = `[PT] Olá! ${response}`;
      }

      // Add upgrade suggestion for non-Premium users
      if (upgradeSuggested && (!user_context || !user_context.isAustralian)) {
        // Only add this if not already added for Australian users
        response += `\n\n[Link Button] <a href="https://www.abeai.health/pricing" target="_blank">Upgrade for personalized plans</a>`;
      }

      // Create response object
      const responseBody = { 
        response, 
        upgrade_suggested: upgradeSuggested,
        debug: {
          user_id,
          subscription_tier,
          history_length: history.length,
          is_australian: !!user_context.isAustralian,
          processing_time_ms: Date.now() - startTime
        }
      };
      
      // Return successful response
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 
          "Content-Type": "application/json", 
          ...corsHeaders
        }
      });
    } catch (err) {
      // Detailed error logging
      console.error("Worker error:", err.message, err.stack);
      
      // Create user-friendly error response with debugging details
      return new Response(JSON.stringify({ 
        response: "I'm having trouble right now. Could you try again in a moment?", 
        error: true,
        debug: {
          error: err.message,
          time: new Date().toISOString(),
          processing_time_ms: Date.now() - startTime
        }
      }), {
        status: 500,
        headers: { 
          "Content-Type": "application/json", 
          ...corsHeaders
        }
      });
    }
  }
};
