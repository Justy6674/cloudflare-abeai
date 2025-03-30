export default {
  async fetch(request, env, ctx) {
    try {
      // 1. CORS: Determine allowed origin for the response
      const origin = request.headers.get("Origin") || "";
      let corsOrigin = null;
      // Allowed origins list (exact matches or patterns)
      const allowedOrigins = [
        "https://abeai.health",
        "https://www.abeai.health",
      ];
      // Pattern match for Vercel preview: "https://abeai-chatbot-webflow-*.vercel.app"
      const vercelPattern = /^https:\/\/abeai-chatbot-webflow-.*\.vercel\.app$/;
      // Optional pattern for any subdomain of downscaleai.com
      const downscalePattern = /^https:\/\/[^.]+\.downscaleai\.com$/;
      if (allowedOrigins.includes(origin) || vercelPattern.test(origin) || downscalePattern.test(origin)) {
        corsOrigin = origin;
      }

      // If this is a preflight OPTIONS request, respond with CORS headers only
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": corsOrigin || "null",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400", // cache preflight for 1 day
          }
        });
      }

      // Only POST requests are expected for the chatbot query
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
          status: 405,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": corsOrigin || "null",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
          }
        });
      }

      // 2. Parse request JSON
      let requestData;
      try {
        requestData = await request.json();
      } catch (e) {
        // Bad JSON or no body
        console.error("Failed to parse JSON request", e);
        return new Response(JSON.stringify({ error: "Invalid JSON request" }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": corsOrigin || "null",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
          }
        });
      }

      // 3. Identify user (for tier/usage tracking)
      let userId = null;
      const authHeader = request.headers.get("Authorization");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        userId = authHeader.slice(7).trim(); // token after "Bearer "
      }
      if (!userId && requestData.userId) {
        userId = String(requestData.userId).trim();
      }
      if (!userId && requestData.user_id) {
        userId = String(requestData.user_id).trim();
      }
      // If still no userId, we could assign a default or treat as anonymous free user.
      // Here, treat as an anonymous user (will be limited as free tier).
      if (!userId) {
        userId = "anonymous:" + (request.headers.get("CF-Connecting-IP") || "unknown");
      }

      // 4. Fetch user tier/usage from KV
      let tier = "free";
      let usageCount = 0;
      try {
        const userRecord = await env.ABEAI_KV.get(userId, { type: "json" });
        if (userRecord) {
          if (userRecord.tier) tier = userRecord.tier;
          if (typeof userRecord.usage === "number") usageCount = userRecord.usage;
        } else {
          // No record found: assume new free user
          tier = "free";
          usageCount = 0;
        }
      } catch (err) {
        console.error(`KV get failed for user ${userId}`, err);
        // If KV read fails, proceed with default free tier to avoid blocking user.
        tier = "free";
        usageCount = 0;
      }

      // 5. Monetization check: Free tier upsell logic
      const forceMonetization = env.FORCE_MONETIZATION === "true";  // (set via wrangler vars)
      let upsellTriggered = false;
      if (tier === "free") {
        if (forceMonetization || usageCount >= 3) {
          upsellTriggered = true;
        }
      }
      // If upsell is triggered, skip the AI call and prepare an upsell response.
      if (upsellTriggered) {
        // Construct an upsell response payload
        const upsellOptions = [
          { tier: "Essentials", description: "Basic plan with expanded usage", link: "https://abeai.health/upgrade#essentials" },
          { tier: "Premium", description: "Premium plan with unlimited coaching", link: "https://abeai.health/upgrade#premium" },
          { tier: "Clinical", description: "Clinical plan with expert guidance", link: "https://abeai.health/upgrade#clinical" }
        ];
        const upsellMessage = "You’ve reached the limit of free responses. Upgrade to continue your health coaching experience.";
        const upsellResponse = {
          assistant: upsellMessage,
          upsell: upsellOptions
        };
        // (We do not increment usageCount here, since no new AI answer was given)
        return new Response(JSON.stringify(upsellResponse), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": corsOrigin || "null",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
          }
        });
      }

      // 6. Prepare OpenAI API request via Cloudflare AI Gateway
      // Remove any adolescent safety prompts or filters (not needed as per new requirements)
      // Build the messages payload for OpenAI
      let openAiMessages = requestData.messages;
      if (!openAiMessages) {
        // If the client just sent a prompt text instead of full messages array
        const userPrompt = requestData.prompt || requestData.query || "";
        openAiMessages = [ { role: "user", content: String(userPrompt) } ];
      }
      // You can prepend a system message if desired to set AI persona (e.g., health coach instructions)
      // e.g., openAiMessages.unshift({ role: "system", content: "You are a helpful health coach AI." });

      const openAiPayload = {
        model: requestData.model || "gpt-3.5-turbo",
        messages: openAiMessages,
        temperature: requestData.temperature ?? 0.7
      };

      const apiUrl = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_NAME}/openai/chat/completions`;
      const aiResponse = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_KEY}`  // OpenAI API key for auth
        },
        body: JSON.stringify(openAiPayload)
      });

      if (!aiResponse.ok) {
        // OpenAI API returned an error status
        const errText = await aiResponse.text();
        console.error(`OpenAI API error: ${aiResponse.status} - ${errText}`);
        return new Response(JSON.stringify({ error: "AI request failed", status: aiResponse.status }), {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": corsOrigin || "null",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
          }
        });
      }

      const resultData = await aiResponse.json();
      // Extract assistant's reply from OpenAI result
      let assistantReply = "";
      try {
        assistantReply = resultData.choices[0].message.content;
      } catch (e) {
        console.error("Unexpected OpenAI response format", e, resultData);
        return new Response(JSON.stringify({ error: "Invalid AI response format" }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": corsOrigin || "null",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
          }
        });
      }

      // 7. Increment usage count for successful response and update KV (for free and other tiers)
      usageCount += 1;
      const newUserRecord = { tier: tier, usage: usageCount };
      try {
        await env.ABEAI_KV.put(userId, JSON.stringify(newUserRecord));
      } catch (err) {
        console.error(`KV put failed for user ${userId}`, err);
        // Not critical to throw an error to user if usage logging fails; just log it.
      }

      // 8. Return the assistant's response as JSON, include upsell flag if nearing limit (optional)
      const responsePayload = { assistant: assistantReply };
      if (tier === "free") {
        // If this was the 3rd free response, we can indicate that the next one will trigger upsell (optional).
        // For simplicity, we won't add that here, but front-end could keep track.
      }
      // (No upsell field here since this response is from AI, not an upsell prompt)
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": corsOrigin || "null",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    } catch (err) {
      // Catch-all for any unexpected errors
      console.error("Unhandled error in Worker fetch", err);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": request.headers.get("Origin") || "null",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }
  }
};
