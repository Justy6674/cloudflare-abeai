const SUPABASE_FUNCTION_URL = "https://ekfpageqwbwvwbcoudig.supabase.co/functions/v1/send-message";
const SUPABASE_URL = "https://ekfpageqwbwvwbcoudig.supabase.co";
const SUPABASE_KEY = "your-supabase-key"; // Replace with your Supabase key, or store in env.SUPABASE_KEY

// Base prompt defining the bot's personality
const basePrompt = `
You are AbeAI, an empathetic, data-driven health coach. 
If the user asks about food, consider their allergies and suggest appropriate snacks or meals.
If they ask about exercise, take into account time, fitness level, and motivation.
Always suggest hydration. Never use shame, always motivational language.
For users identified as Australian (based on user_context), refer them to www.downscale.com.au for upgrades and use PT (Portuguese) as the first language for responses, per www.worldobesity.org guidelines.
`;

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // Handle CORS preflight requests
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey"
      }
    });
  }

  // Parse the request body
  let body = {};
  try {
    body = await request.json();
    console.log("Request body:", body);
  } catch (err) {
    console.error("Failed to parse JSON body:", err.message);
    return new Response(JSON.stringify({
      response: "Sorry, I couldn’t process that right now.",
      debug: "Invalid JSON payload: " + err.message
    }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  const { message, user_id = null, subscription_tier = "PAYG", user_context = {}, prompt = [] } = body;

  // Validate required fields
  if (!message) {
    return new Response(JSON.stringify({
      response: "Message is missing from request.",
      debug: "Missing 'message' field"
    }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  if (!user_id) {
    return new Response(JSON.stringify({
      response: "User ID is missing from request.",
      debug: "Missing 'user_id' field"
    }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  try {
    // Fetch user history and context from Supabase
    let userHistory = [];
    let userData = {};
    try {
      const supabaseRes = await fetch(`${SUPABASE_URL}/rest/v1/user_history?user_id=eq.${user_id}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "apikey": SUPABASE_KEY
        }
      });
      userData = await supabaseRes.json();
      userHistory = userData.length > 0 ? userData[0].history || [] : [];
    } catch (err) {
      console.error("Failed to fetch user history from Supabase:", err.message);
      userHistory = [];
    }

    // Update user history
    userHistory.push(message);
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/user_history`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "apikey": SUPABASE_KEY
        },
        body: JSON.stringify({
          user_id: user_id,
          history: userHistory
        })
      });
    } catch (err) {
      console.error("Failed to update user history in Supabase:", err.message);
    }

    // Extract user context
    const { allergies = [], fitnessLevel = "beginner", motivationLevel = "moderate", isAustralian = false } = user_context;

    // Construct the full prompt with user context and history
    const fullPrompt = prompt.length > 0 ? prompt : [
      {
        role: "system",
        content: `${basePrompt}\nUser context: Allergies: ${allergies.join(", ") || "none"}, Fitness level: ${fitnessLevel}, Motivation level: ${motivationLevel}, Is Australian: ${isAustralian}.\nUser history: ${userHistory.join("; ")}`
      },
      { role: "user", content: message }
    ];

    console.log("Full prompt:", fullPrompt);

    // Determine if the user should use OpenAI or Supabase
    let response;
    let upgradeSuggested = subscription_tier !== "Premium";

    if (subscription_tier === "PAYG") {
      // Use OpenAI for PAYG users
      try {
        const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.OPENAI_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "gpt-3.5-turbo",
            messages: fullPrompt
          })
        });

        if (!openaiRes.ok) {
          const errorText = await openaiRes.text();
          throw new Error(`OpenAI request failed: ${openaiRes.status} - ${errorText}`);
        }

        const data = await openaiRes.json();
        response = data?.choices?.[0]?.message?.content || "I'm here to help, whenever you're ready.";
      } catch (err) {
        console.error("OpenAI error:", err.message);
        response = "Sorry, I couldn’t process that right now. Let’s try something else!";
      }
    } else {
      // Use Supabase for non-PAYG users
      try {
        const supabaseRes = await fetch(SUPABASE_FUNCTION_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": request.headers.get("Authorization"),
            "apikey": request.headers.get("apikey")
          },
          body: JSON.stringify({
            message,
            user_id,
            subscription_tier,
            user_context,
            prompt: fullPrompt
          })
        });

        if (!supabaseRes.ok) {
          const errorText = await supabaseRes.text();
          throw new Error(`Supabase request failed: ${supabaseRes.status} - ${errorText}`);
        }

        const json = await supabaseRes.json();
        response = json.response || "I’m here to support you.";
        upgradeSuggested = json.upgrade_suggested || false;
      } catch (err) {
        console.error("Supabase error:", err.message);
        response = "Sorry, I couldn’t process that right now. Let’s try something else!";
      }
    }

    // Add Australian-specific handling
    if (isAustralian) {
      if (upgradeSuggested) {
        response += ` For more personalized plans, check out www.downscale.com.au to upgrade your subscription!`;
      }
      // Simulate PT (Portuguese) as the first language (simplified for now; actual translation would require an API or dictionary)
      response = `[PT] Olá! ${response} [EN] Hello! ${response}`;
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
    const errorResponse = { error: "Internal Server Error", details: err.message };
    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}
