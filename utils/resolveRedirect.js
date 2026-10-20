export default async function resolveOriginalRedirect(supabase, redirectedId) {
  let currentId = redirectedId;
  const visited = new Set(); // Защита от циклов
  while (currentId) {
    if (visited.has(currentId)) {
      throw new Error("Цикл в цепочке редиректов");
    }
    visited.add(currentId);
    
    const { data: msg, error } = await supabase
      .from("messages")
      .select("redirected_id")
      .eq("id", currentId)
      .single();
    
    if (error || !msg) {
      throw new Error("Ошибка при разрешении редиректа");
    }
    
    if (msg.redirected_id === null) {
      return currentId; // Оригинал найден
    }
    currentId = msg.redirected_id;
  }
  return redirectedId; // Если null с самого начала
}