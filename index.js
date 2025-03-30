export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS preflight (OPTIONS request)
    if (request.method === "OPTIONS") {
      return new Response(null, { 
        status: 204, 
        headers: {
          "Access-Control-Allow-Origin": "*",  // allow all origins or specify your domain
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    // 2. Authorization check for incoming requests
    const authHeader = request.headers.get("Authorization");
    const token = env.AUTH_TOKEN;  // set this in Worker env to your chosen API token
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { 
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // 3. Parse the request JSON (expects a message and sessionId)
    let reqData;
    try {
      reqData = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Bad Request" }), { status: 400 });
    }
    const userMessage = reqData.message;
    let sessionId = reqData.sessionId;

    // 4. Generate a new sessionId if not provided
    if (!sessionId) {
      sessionId = crypto.randomUUID();  // unique ID for the conversation
      // Initialize a new context object for this session
      const initialContext = {
        tier: "free",           // default tier
        messages: [],           // will hold past messages {role, content}
        safety: 0,              // safety flag/violation count
        responses: 0            // number of responses given
      };
      await env.ABEAI_KV.put(`ctx:${sessionId}`, JSON.stringify(initialContext));
    }

    // 5. Fetch existing context from KV
    const ctxKey = `ctx:${sessionId}`;
    let context = await env.ABEAI_KV.get(ctxKey);
    context = context ? JSON.parse(context) : { tier: "free", messages: [], safety: 0, responses: 0 };

    // 6. Build the message history for OpenAI, including system prompt and context
    const SYSTEM_PROMPT = env.SYSTEM_PROMPT 
      || "You are AbeAI, a knowledgeable and compassionate health coach. Provide helpful, accurate nutrition and wellness advice.";
    const messages = [{ role: "system", content: SYSTEM_PROMPT }];
    // include previous dialogue from context (to maintain conversation)
    if (context.messages && context.messages.length) {
      messages.push(...context.messages);
    }
    // add the new user message
    messages.push({ role: "user", content: userMessage });

    // 7. Choose model based on user tier
    const model = context.tier === "pro" ? "gpt-4" : "gpt-3.5-turbo";

    // 8. Prepare the OpenAI API request via Cloudflare AI Gateway
    const openaiPayload = { model, messages /*, max_tokens, temperature, etc., if needed */ };
    const gatewayAccount = env.CF_ACCOUNT_ID;       // your Cloudflare account ID
    const gatewayName   = env.CF_GATEWAY_NAME || "abeai-openai-gateway";
    const openaiURL = `https://gateway.ai.cloudflare.com/v1/${gatewayAccount}/${gatewayName}/openai/chat/completions`;
    const openaiHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.OPENAI_KEY}`       // OpenAI API key as Bearer
    };
    if (env.CF_AIG_TOKEN) {
      // Authenticated Gateway token, if gateway authentication is enabled
      openaiHeaders["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
    }

    // 9. Call the OpenAI API (through Cloudflare AI Gateway)
    let aiResponse;
    try {
      aiResponse = await fetch(openaiURL, {
        method: "POST",
        headers: openaiHeaders,
        body: JSON.stringify(openaiPayload)
      });
    } catch (err) {
      // Network or other fetch error
      return new Response(JSON.stringify({ error: "Failed to contact AI service", details: err.message }), { 
        status: 502, 
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    if (!aiResponse.ok) {
      // OpenAI API returned an error (e.g., invalid key or other issue)
      const errText = await aiResponse.text();
      return new Response(JSON.stringify({ error: "OpenAI API Error", status: aiResponse.status, details: errText }), { 
        status: 500, 
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const completion = await aiResponse.json();
    const assistantReply = completion.choices?.[0]?.message?.content || "";

    // 10. Update context with the new Q&A
    context.messages = context.messages || [];
    context.messages.push({ role: "user", content: userMessage });
    context.messages.push({ role: "assistant", content: assistantReply });
    context.responses = (context.responses || 0) + 1;
    // (Optional: implement content safety checks or tier upgrades if needed)
    await env.ABEAI_KV.put(ctxKey, JSON.stringify(context));

    // 11. Return the assistant's reply (and sessionId for reference) to the frontend
    const responsePayload = { reply: assistantReply, sessionId: sessionId };
    return new Response(JSON.stringify(responsePayload), { 
      status: 200,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*" 
      }
    });
  }
};
