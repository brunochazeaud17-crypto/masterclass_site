// Remplit dynamiquement la liste des créneaux horaires. Les dates sont
// exprimées en ISO 8601 (UTC). Ajustez ces valeurs pour proposer des
// horaires adaptés à votre public et à votre disponibilité.
/**
 * Générer et afficher un calendrier interactif pour la sélection des créneaux.
 * Au chargement du DOM, cette fonction construit un calendrier sur 14 jours
 * avec des horaires adaptés aux différents jours de la semaine. Chaque
 * créneau est cliquable : il met à jour le champ caché "session" avec
 * la date ISO correspondante et met en surbrillance l'heure choisie.
 */
document.addEventListener('DOMContentLoaded', () => {
  const datePicker = document.getElementById('date-picker');
  const timePicker = document.getElementById('time-picker');
  const sessionInput = document.getElementById('session');
  if (!datePicker || !timePicker || !sessionInput) return;
  const today = new Date();
  const dates = [];
  // Générer les 14 prochains jours à partir d’aujourd’hui
  for (let offset = 0; offset < 14; offset++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    dates.push(d);
  }
  // Fonction pour déterminer les horaires en fonction du jour de la semaine
  function getTimesForDate(d) {
    const dow = d.getDay();
    // Ajout d'une séance exceptionnelle le samedi 23 août 2025 à 22h00
    if (
      d.getFullYear() === 2025 &&
      d.getMonth() === 7 &&
      d.getDate() === 23 &&
      dow === 6
    ) {
      // Reprendre les créneaux du samedi et ajouter 22h00
      return ['09:30', '14:00', '16:00', '18:30', '20:30', '22:00'];
    }
    if (dow >= 1 && dow <= 4) {
      // Lundi à jeudi
      return ['15:00', '18:30', '20:30'];
    } else if (dow === 5) {
      // Vendredi
      return ['09:30', '15:00', '19:30'];
    } else if (dow === 6) {
      // Samedi : remplacer 15h par 16h
      return ['09:30', '14:00', '16:00', '18:30', '20:30'];
    } else {
      // Dimanche : ajouter des créneaux le matin (10h30, 11h30, 12h30) en plus des
      // créneaux existants. On conserve également 15h pour ceux qui le souhaitent.
      return ['09:30', '10:30', '11:10', '11:30', '12:30', '14:00', '15:00', '17:09', '18:30', '20:30'];
    }
  }
  // Générer l’interface des dates
  dates.forEach((d, index) => {
    const dayEl = document.createElement('div');
    dayEl.className = 'day';
    // Afficher à la fois le numéro du jour et le nom du jour/mois pour
    // améliorer la lisibilité (ex : « mar 23 août »). Le numéro est mis
    // en avant et les textes complémentaires sont placés en-dessous.
    const dayNumber = d.getDate();
    const dayName = d.toLocaleDateString('fr-FR', { weekday: 'short' });
    const monthName = d.toLocaleDateString('fr-FR', { month: 'short' });
    dayEl.innerHTML = `<span class="day-number">${dayNumber}</span><br/><span class="day-label">${dayName} ${monthName}</span>`;
    dayEl.title = d.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' });
    dayEl.addEventListener('click', () => {
      selectDate(index);
    });
    datePicker.appendChild(dayEl);
  });
  let selectedDateIndex = null;
  function selectDate(idx) {
    selectedDateIndex = idx;
    const dateEls = datePicker.querySelectorAll('.day');
    dateEls.forEach((el, i) => {
      el.classList.toggle('selected', i === idx);
    });
    const d = dates[idx];
    // Mettre à jour le panneau des horaires
    timePicker.innerHTML = '';
    const times = getTimesForDate(d);
    times.forEach(timeStr => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = timeStr;
      btn.addEventListener('click', () => {
        // Déselectionner les autres boutons
        const buttons = timePicker.querySelectorAll('button');
        buttons.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        const [hh, mm] = timeStr.split(':');
        const eventDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), parseInt(hh, 10), parseInt(mm, 10));
        sessionInput.value = eventDate.toISOString();
      });
      timePicker.appendChild(btn);
    });
  }

  // Sélectionner automatiquement le premier jour et afficher ses horaires
  // Cela améliore l’expérience utilisateur : dès l’arrivée sur la page,
  // un jeu de créneaux est visible sans qu’un clic soit nécessaire. Ce
  // comportement s’inspire des sélecteurs de rendez‑vous professionnels.
  if (dates.length > 0) {
    selectDate(0);
  }
});