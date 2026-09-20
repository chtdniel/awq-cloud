export async function onRequest(context) {
  // context.env.DB mengacu pada binding 'DB' yang ada di wrangler.toml
  try {
    // Contoh query dasar, pastikan tabel sudah dibuat via schema.sql
    const { results } = await context.env.DB.prepare('SELECT * FROM flights LIMIT 10').all();
    
    return Response.json({
      success: true,
      message: "AWQ-CLOUD API running normally",
      data: results
    });
  } catch (error) {
    return Response.json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
}
