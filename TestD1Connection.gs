/**
 * Test script to verify the connection between Google Apps Script and Cloudflare D1.
 * Run the `testD1Connection` function directly from the Google Apps Script editor.
 */

function testD1Connection() {
  Logger.log("Starting D1 connection test...");
  
  try {
    // 1. Create a simple table (if it doesn't exist)
    Logger.log("1. Creating test table...");
    var createResult = D1Helper.run(
      "CREATE TABLE IF NOT EXISTS test_users (id INTEGER PRIMARY KEY, name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
    );
    Logger.log("Create Table Result: " + JSON.stringify(createResult));
    
    // 2. Insert a test record
    Logger.log("2. Inserting test data...");
    var randomName = "TestUser_" + Math.floor(Math.random() * 1000);
    var insertResult = D1Helper.run(
      "INSERT INTO test_users (name) VALUES (?)", 
      [randomName]
    );
    Logger.log("Insert Result: " + JSON.stringify(insertResult));
    
    // 3. Select the data back
    Logger.log("3. Fetching data...");
    var users = D1Helper.select("SELECT * FROM test_users ORDER BY id DESC LIMIT 5");
    
    Logger.log("=== SUCCESS! ===");
    Logger.log("Connection is working perfectly. Found " + users.length + " users.");
    
    // Log the fetched users nicely
    for (var i = 0; i < users.length; i++) {
      Logger.log("- User ID " + users[i].id + ": " + users[i].name + " (Created: " + users[i].created_at + ")");
    }
    
  } catch (error) {
    Logger.log("=== ERROR ===");
    Logger.log(error.toString());
    Logger.log("Hint: Check your D1_WORKER_URL and D1_API_KEY in Project Settings > Script Properties.");
  }
}
