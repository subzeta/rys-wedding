const form = document.getElementById("menuForm");
const confirmation = document.getElementById("confirmation");

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const guestName = formData.get("guestName");
  const stayOvernight = formData.get("stayOvernight") === "on";
  const dietType = formData.get("dietType");
  const needs = formData.getAll("needs");
  const starter = formData.get("starter");
  const main = formData.get("main");
  const dessert = formData.get("dessert");
  const notes = formData.get("notes");

  confirmation.innerHTML = `
    <h3>Reserva recibida 🐱</h3>
    <p><strong>Invitado/a:</strong> ${guestName}</p>
    <p><strong>Se queda a dormir:</strong> ${stayOvernight ? "Si" : "No"}</p>
    <p><strong>Tipo de menu:</strong> ${dietType}</p>
    <p><strong>Necesidades alimentarias:</strong> ${needs.length ? needs.join(", ") : "Ninguna indicada"}</p>
    <p><strong>Entrante:</strong> ${starter}</p>
    <p><strong>Principal:</strong> ${main}</p>
    <p><strong>Postre:</strong> ${dessert}</p>
    <p><strong>Comentarios:</strong> ${notes ? notes : "Sin comentarios"}</p>
    <p>Gracias por confirmar tu menu para la boda de Raquel y Sergio. ¡Nos vemos pronto! 🐾</p>
  `;

  confirmation.classList.add("show");
  form.reset();
});
