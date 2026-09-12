/**
 * Cloudflare Worker for D1 Database Access
 * This acts as an API bridge between Google Apps Script and Cloudflare D1.
 */

export default {
  async fetch(request, env) {
    // 1. Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Only allow POST requests for database operations
    if (request.method !== "POST") {
      return new Response("Method not allowed. Use POST.", { status: 405 });
    }

    // 2. Authentication (Security Check)
    // Ensure the API_KEY environment variable is set in the Cloudflare dashboard / wrangler.toml
    const authHeader = request.headers.get("Authorization");
    const expectedAuth = `Bearer ${env.API_KEY}`;
    
    if (!env.API_KEY) {
      return new Response("Server error: API_KEY is not configured on the worker.", { status: 500 });
    }
    if (!authHeader || authHeader !== expectedAuth) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 3. Process the Request
    try {
      const body = await request.json();
      const { query, params } = body;

      if (!query) {
        return new Response("Missing 'query' in request body", { status: 400 });
      }

      // 4. Execute the Query on D1
      // env.DB is the D1 binding name configured in Cloudflare (must match exactly)
      if (!env.DB) {
        return new Response("Server error: D1 Database binding 'DB' is not configured.", { status: 500 });
      }

      let stmt = env.DB.prepare(query);
      
      // Bind parameters if they exist (e.g., [value1, value2]) to prevent SQL injection
      if (params && Array.isArray(params)) {
        stmt = stmt.bind(...params);
      }

      // Execute the query
      const { results, success, meta } = await stmt.all();

      if (!success) {
        return new Response(JSON.stringify({ error: "Query execution failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }

      // 5. Return the Results
      return new Response(JSON.stringify({ success: true, results, meta }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  },
};
