const form = document.getElementById("menuForm");
const confirmation = document.getElementById("confirmation");
const guestsContainer = document.getElementById("guestsContainer");
const addGuestButton = document.getElementById("addGuest");
const step1 = document.getElementById("step1");

function setAdultFieldsState(card, isAdult) {
  const adultOnlyFields = card.querySelectorAll(".adult-only-field");
  const kidOnlyFields = card.querySelectorAll(".kid-only-field");
  const dietInput = card.querySelector('input[name="dietType[]"]');

  adultOnlyFields.forEach((field) => {
    field.classList.toggle("hidden", !isAdult);
  });

  kidOnlyFields.forEach((field) => {
    field.classList.toggle("hidden", isAdult);
  });

  if (dietInput) {
    if (isAdult) {
      if (dietInput.value === "Menu infantil") {
        dietInput.value = "";
      }
    } else {
      dietInput.value = "Menu infantil";
    }
  }

  const dietButtons = card.querySelectorAll(
    '.choice-group[data-field="dietType"] .choice-btn'
  );
  dietButtons.forEach((button) => {
    button.classList.remove("is-active");
  });

  if (!isAdult) {
    const childDietButton = card.querySelector(
      '.choice-group[data-field="dietType"] .choice-btn[data-value="Menu infantil"]'
    );
    if (childDietButton instanceof HTMLElement) {
      childDietButton.classList.add("is-active");
    }
  }
}

function createGuestCard(index) {
  const card = document.createElement("article");
  card.className = "guest-card";
  card.dataset.guestIndex = String(index);

  const removeButton =
    index === 0
      ? ""
      : '<button type="button" class="btn-link remove-guest">Eliminar</button>';

  card.innerHTML = `
    <div class="guest-card-header">
      <h3>Invitado ${index + 1}</h3>
      ${removeButton}
    </div>

    <label>
      Nombre
      <input type="text" name="guestName[]" required placeholder="" />
    </label>

    <label>
      Tipo
      <div class="choice-group" data-field="guestKind" role="radiogroup" aria-label="Tipo de invitado">
        <button type="button" class="choice-btn is-active" data-value="Adulto">Adulto/a</button>
        <button type="button" class="choice-btn" data-value="Nino">Niño/a</button>
        <input type="hidden" name="guestKind[]" value="Adulto" />
      </div>
    </label>

    <label class="adult-only-field">
      Tipo de menú
      <div class="choice-group" data-field="dietType" role="radiogroup" aria-label="Tipo de menú">
        <button
          type="button"
          class="choice-btn"
          data-value="Omnívoro - bacalao gratinado con muselina de ajo, hummus negro y verduritas salteadas"
        >
          Omnívoro bacalao
        </button>
        <button
          type="button"
          class="choice-btn"
          data-value="Omnívoro - meloso de ternera com parmentier de patata y salsa de vino negro"
        >
          Omnívoro ternera
        </button>
        <button type="button" class="choice-btn" data-value="Vegetariano">Vegetariano</button>
        <button type="button" class="choice-btn" data-value="Vegano">Vegano</button>
        <input type="hidden" name="dietType[]" value="" />
      </div>
    </label>

    <p class="kid-only-field hidden">Menú infantil (automático).</p>

    <label>
      Alojamiento (y desayuno)
      <div class="choice-group" data-field="stayOvernight" role="radiogroup" aria-label="Alojamiento y desayuno">
        <button type="button" class="choice-btn" data-value="Si">Sí</button>
        <button type="button" class="choice-btn" data-value="No">No</button>
        <input type="hidden" name="stayOvernight[]" value="" />
      </div>
    </label>

    <label>
      Comentarios (opcional)
      <textarea
        name="guestNotes[]"
        rows="3"
        placeholder="Alergias, intolerancias o cualquier detalle"
      ></textarea>
    </label>
  `;

  setAdultFieldsState(card, true);
  return card;
}

function updateGuestTitles() {
  const cards = guestsContainer.querySelectorAll(".guest-card");

  cards.forEach((card, index) => {
    const title = card.querySelector("h3");
    if (title) {
      title.textContent = `Invitado ${index + 1}`;
    }
  });
}

function getGuestData(card) {
  const nameInput = card.querySelector('input[name="guestName[]"]');
  const kindInput = card.querySelector('input[name="guestKind[]"]');
  const dietInput = card.querySelector('input[name="dietType[]"]');
  const stayInput = card.querySelector('input[name="stayOvernight[]"]');
  const notesInput = card.querySelector('textarea[name="guestNotes[]"]');

  const guestKind = kindInput ? kindInput.value : "Adulto";

  return {
    name: nameInput ? nameInput.value.trim() : "",
    guestKind,
    dietType: dietInput ? dietInput.value : "",
    stayOvernight: stayInput ? stayInput.value : "",
    notes: notesInput ? notesInput.value.trim() : ""
  };
}

function validateStep1() {
  const step1Fields = step1.querySelectorAll('input[type="text"], textarea');

  for (const field of step1Fields) {
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      if (!field.checkValidity()) {
        field.reportValidity();
        return false;
      }
    }
  }

  const cards = guestsContainer.querySelectorAll(".guest-card");
  for (const card of cards) {
    const guestData = getGuestData(card);
    if (!guestData.guestKind) {
      alert("Falta seleccionar si algún invitado es adulto o niño.");
      return false;
    }

    if (!guestData.dietType) {
      alert("Falta seleccionar el menú de algún invitado.");
      return false;
    }

    if (!guestData.stayOvernight) {
      alert("Falta indicar si algún invitado se queda a dormir.");
      return false;
    }
  }

  return true;
}

function buildConfirmationHtml(contactName, guests) {
  const guestItems = guests
    .map((guest, index) => {
      return `
        <li>
          <p><strong>${index + 1}. ${guest.name}</strong> (${guest.guestKind === "Nino" ? "Niño/a" : "Adulto/a"})</p>
          <p><strong>Menú:</strong> ${guest.dietType}</p>
          <p><strong>Se queda a dormir:</strong> ${guest.stayOvernight}</p>
          <p><strong>Comentarios:</strong> ${guest.notes || "Sin comentarios"}</p>
        </li>
      `;
    })
    .join("");

  return `
    <h3>Respuesta guardada</h3>
    <p><strong>Completado por:</strong> ${contactName}</p>
    <p><strong>Total de invitados:</strong> ${guests.length}</p>
    <ol class="confirmation-list">${guestItems}</ol>
    <p>Gracias por confirmar. Nos hace mucha ilusión celebrar este día con vosotros.</p>
  `;
}

function setChoiceValue(group, button) {
  if (!(group instanceof HTMLElement) || !(button instanceof HTMLElement)) {
    return;
  }

  const value = button.dataset.value || "";
  const hiddenInput = group.querySelector('input[type="hidden"]');
  if (!(hiddenInput instanceof HTMLInputElement)) {
    return;
  }

  group.querySelectorAll(".choice-btn").forEach((btn) => {
    btn.classList.remove("is-active");
  });
  button.classList.add("is-active");
  hiddenInput.value = value;
}

addGuestButton.addEventListener("click", () => {
  const nextIndex = guestsContainer.querySelectorAll(".guest-card").length;
  const newCard = createGuestCard(nextIndex);
  guestsContainer.appendChild(newCard);
  updateGuestTitles();
});

guestsContainer.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains("remove-guest")) {
    return;
  }

  const card = target.closest(".guest-card");
  if (!card) {
    return;
  }

  card.remove();
  updateGuestTitles();
});

guestsContainer.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const button = target.closest(".choice-btn");
  if (!(button instanceof HTMLElement)) {
    return;
  }

  const group = button.closest(".choice-group");
  if (!(group instanceof HTMLElement)) {
    return;
  }

  setChoiceValue(group, button);

  const card = target.closest(".guest-card");
  if (!card) {
    return;
  }

  if (group.dataset.field === "guestKind") {
    setAdultFieldsState(card, button.dataset.value === "Adulto");
    return;
  }

});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!validateStep1()) {
    return;
  }

  const contactNameInput = form.querySelector('input[name="contactName"]');
  const cards = guestsContainer.querySelectorAll(".guest-card");

  if (!contactNameInput || !cards.length) {
    return;
  }

  const guests = Array.from(cards).map((card) => getGuestData(card));

  const payload = {
    contactName: contactNameInput.value.trim(),
    guests
  };

  const endpoint = form.dataset.endpoint;

  if (endpoint) {
    try {
      const cc = (form.dataset.cc || "").trim();
      const formData = new FormData();
      formData.append("contact_name", payload.contactName);
      formData.append("total_people", String(payload.guests.length));
      formData.append("guests", JSON.stringify(payload.guests));
      formData.append("_subject", "Nueva confirmación de asistencia");
      formData.append("_captcha", "false");
      formData.append("_template", "table");
      if (cc) {
        formData.append("_cc", cc);
      }

      const response = await fetch(endpoint, {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        throw new Error("No se pudo guardar la respuesta.");
      }
    } catch (error) {
      alert("No se pudo guardar online. Se muestra el resumen igualmente.");
    }
  }

  confirmation.innerHTML = buildConfirmationHtml(
    payload.contactName,
    payload.guests
  );
  confirmation.classList.add("show");
});
