/**
 * D1Helper.gs
 * Google Apps Script helper to communicate with Cloudflare D1 Database via Cloudflare Worker.
 */

var D1Helper = (function() {
  
  // ==========================================
  // CONFIGURATION
  // ==========================================
  
  // You should store these in Google Apps Script > Project Settings > Script Properties
  // - D1_WORKER_URL: The full URL of your deployed Cloudflare Worker (e.g., https://your-worker.your-subdomain.workers.dev)
  // - D1_API_KEY: The secret key that matches the API_KEY env variable in your Worker.
  
  function getWorkerUrl() {
    var url = PropertiesService.getScriptProperties().getProperty('D1_WORKER_URL');
    if (!url) throw new Error("D1_WORKER_URL is not set in Script Properties.");
    return url;
  }
  
  function getApiKey() {
    var key = PropertiesService.getScriptProperties().getProperty('D1_API_KEY');
    if (!key) throw new Error("D1_API_KEY is not set in Script Properties.");
    return key;
  }

  // ==========================================
  // CORE FUNCTIONS
  // ==========================================
  
  /**
   * Executes a query against the Cloudflare D1 Database.
   * 
   * @param {string} query - The SQL query to execute (e.g., "SELECT * FROM users WHERE id = ?").
   * @param {Array} params - (Optional) Array of values to bind to the query parameters to prevent SQL injection.
   * @returns {Object} The JSON response from the Worker (contains success status and results).
   */
  function executeQuery(query, params) {
    if (!query) throw new Error("Query cannot be empty.");
    
    var url = getWorkerUrl();
    var apiKey = getApiKey();
    
    var payload = {
      query: query
    };
    
    // Add parameters if provided
    if (params && Array.isArray(params)) {
      payload.params = params;
    }
    
    var options = {
      method: "post",
      contentType: "application/json",
      headers: {
        "Authorization": "Bearer " + apiKey
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true // Get the full response even on errors like 401/500
    };
    
    try {
      var response = UrlFetchApp.fetch(url, options);
      var responseCode = response.getResponseCode();
      var responseText = response.getContentText();
      
      // Parse the response
      var result = JSON.parse(responseText);
      
      if (responseCode !== 200 || !result.success) {
        throw new Error("D1 Error (" + responseCode + "): " + (result.error || responseText));
      }
      
      return result;
      
    } catch (e) {
      // Log the error for debugging in GAS
      console.error("D1Helper Error Executing Query: " + query, e);
      throw e;
    }
  }

  // ==========================================
  // HELPER METHODS FOR COMMON OPERATIONS
  // ==========================================
  
  /**
   * Selects data from a table.
   * @param {string} query The SELECT query.
   * @param {Array} params Optional parameters.
   * @returns {Array} Array of result rows.
   */
  function select(query, params) {
    var result = executeQuery(query, params);
    return result.results || [];
  }
  
  /**
   * Executes an INSERT, UPDATE, or DELETE statement.
   * @param {string} query The SQL statement.
   * @param {Array} params Optional parameters.
   * @returns {Object} Meta object containing details like changes/last_insert_rowid.
   */
  function run(query, params) {
    var result = executeQuery(query, params);
    return result.meta || {};
  }
  
  // Public API
  return {
    query: executeQuery,
    select: select,
    run: run
  };
  
})();
