import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

// --- 🔥 CONFIGURACIÓN DE FIREBASE ---
const firebaseConfig = {
  apiKey: "AIzaSyAjWtEeVUDQFrPYGXRpRxK9J_Gf4M77lyw",
  authDomain: "organizador-academico-35d9d.firebaseapp.com",
  projectId: "organizador-academico-35d9d",
  storageBucket: "organizador-academico-35d9d.firebasestorage.app",
  messagingSenderId: "191522787552",
  appId: "1:191522787552:web:db08851e1d472ebb628085"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive.file');
provider.setCustomParameters({ prompt: 'select_account' }); // Permite elegir cuenta de Google siempre

const tasksRef = collection(db, "academicTasks");
let currentUser = null; 
let accessToken = localStorage.getItem('googleDriveToken');
let unsubscribeSnapshot = null;

document.addEventListener('DOMContentLoaded', () => {
    // Referencias DOM
    const taskForm = document.getElementById('task-form');
    const taskList = document.getElementById('task-list');
    const filterSubject = document.getElementById('filter-subject');
    const submitBtn = document.getElementById('submit-btn');
    const cancelEditBtn = document.getElementById('cancel-edit-btn');
    const themeToggle = document.getElementById('theme-toggle');
    const btnExport = document.getElementById('btn-export');
    const btnExportIcs = document.getElementById('btn-export-ics'); // Botón de Calendario
    const btnLogin = document.getElementById('btn-login');
    const btnLogout = document.getElementById('btn-logout');
    const loginOverlay = document.getElementById('login-overlay');
    const userNameDisplay = document.getElementById('user-name-display');
    const statusDisplay = document.getElementById('upload-status');
    const monthYearDisplay = document.getElementById('month-year');
    const calendarDays = document.getElementById('calendar-days');

    let tasks = []; 
    let editingId = null;
    let selectedDateFilter = null; 
    let currentDate = new Date();
    let currentMonth = currentDate.getMonth();
    let currentYear = currentDate.getFullYear();

    initTheme();

    // --- AUTENTICACIÓN ---
    onAuthStateChanged(auth, (user) => {
        if (user) {
            currentUser = user;
            loginOverlay.classList.add('hidden');
            userNameDisplay.textContent = user.displayName;
            loadUserTasks();
        } else {
            currentUser = null;
            loginOverlay.classList.remove('hidden');
            tasks = [];
            updateDashboard();
            if (unsubscribeSnapshot) unsubscribeSnapshot();
            localStorage.removeItem('googleDriveToken');
            accessToken = null;
        }
    });

    btnLogin.addEventListener('click', async () => {
        btnLogin.textContent = 'Conectando...';
        try {
            const result = await signInWithPopup(auth, provider);
            const credential = GoogleAuthProvider.credentialFromResult(result);
            accessToken = credential.accessToken; 
            localStorage.setItem('googleDriveToken', accessToken);
        } catch (error) {
            alert("Error al iniciar sesión.");
            btnLogin.textContent = 'Ingresar con Google';
        }
    });

    btnLogout.addEventListener('click', () => { signOut(auth); });

    // --- LÓGICA DE GOOGLE DRIVE ---
    async function uploadToDrive(file, folderName) {
        if (!accessToken) return null;
        try {
            statusDisplay.textContent = `☁️ Subiendo "${file.name}"...`;
            statusDisplay.classList.remove('hidden');

            const masterId = await getOrCreateFolder("Organizador", "root");
            const subjectId = await getOrCreateFolder(folderName, masterId);
            
            const folderRes = await fetch(`https://www.googleapis.com/drive/v3/files/${subjectId}?fields=webViewLink`, {
                headers: { 'Authorization': 'Bearer ' + accessToken }
            });
            const folderData = await folderRes.json();

            statusDisplay.textContent = `📂 Guardando en carpeta: Organizador/${folderName}`;

            const metadata = { name: file.name, parents: [subjectId] };
            const formData = new FormData();
            formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            formData.append('file', file);

            const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
                method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken }, body: formData
            });
            const fileData = await res.json();
            
            statusDisplay.textContent = `✅ ¡Archivo guardado con éxito!`;
            
            return { fileLink: fileData.webViewLink, folderLink: folderData.webViewLink };
        } catch (e) { 
            statusDisplay.textContent = `❌ Error al subir a Drive`;
            return null; 
        }
    }

    async function getOrCreateFolder(name, parentId) {
        const q = encodeURIComponent(`name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`);
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
            headers: { 'Authorization': 'Bearer ' + accessToken }
        });
        const data = await res.json();
        if (data.files && data.files.length > 0) return data.files[0].id;
        const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
        });
        const folder = await createRes.json();
        return folder.id;
    }

    // --- FIREBASE CRUD ---
    function loadUserTasks() {
        if (!currentUser) return;
        const q = query(tasksRef, where("userId", "==", currentUser.uid));
        unsubscribeSnapshot = onSnapshot(q, (snapshot) => {
            tasks = [];
            snapshot.forEach(docSnap => tasks.push({ id: docSnap.id, ...docSnap.data() }));
            updateDashboard();
        });
    }

    taskForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fileInput = document.getElementById('task-file');
        const subject = document.getElementById('task-subject').value;
        const name = document.getElementById('task-name').value;
        const date = document.getElementById('task-date').value;
        
        submitBtn.disabled = true;
        submitBtn.innerHTML = 'Procesando...';
        
        let driveData = null;

        if (fileInput.files.length > 0) {
            driveData = await uploadToDrive(fileInput.files[0], subject);
        }

        const taskData = { 
            name, subject, date, 
            fileMaterial: driveData ? driveData.fileLink : "",
            folderMaterial: driveData ? driveData.folderLink : "", 
            userId: currentUser.uid, 
            completed: false 
        };

        try {
            if (editingId) {
                await updateDoc(doc(db, "academicTasks", editingId), taskData);
                exitEditMode();
            } else {
                await addDoc(tasksRef, taskData);
            }
            taskForm.reset();
        } catch (err) { console.error(err); }
        
        submitBtn.disabled = false;
        submitBtn.innerHTML = 'Guardar Tarea';
        
        setTimeout(() => { statusDisplay.classList.add('hidden'); }, 3000);
    });

    // --- FILTROS Y EXPORTAR ---
    filterSubject.addEventListener('change', () => {
        selectedDateFilter = null;
        updateDashboard();
    });

    btnExport.addEventListener('click', () => {
        if (tasks.length === 0) return alert("No hay tareas para exportar.");
        const headers = ["Tarea", "Asignatura", "Fecha Limite", "Estado", "Link Carpeta Drive"];
        const rows = tasks.map(t => [
            t.name.replace(/,/g,""), 
            t.subject.replace(/,/g,""), 
            t.date, 
            t.completed ? "Completada" : "Pendiente", 
            t.folderMaterial || "Sin carpeta"
        ].join(","));
        
        const csv = "\ufeff" + headers.join(",") + "\n" + rows.join("\n");
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `Plan_Academico_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
    });

    // --- EXPORTAR A CALENDARIO (.ics) ---
    btnExportIcs.addEventListener('click', () => {
        if (tasks.length === 0) return alert("No hay tareas para exportar.");
        
        let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Organizador Academico UFRO//ES\n";
        
        tasks.forEach(t => {
            if (t.completed) return; 

            const dateStr = t.date.replace(/-/g, "");
            const desc = t.folderMaterial ? `Link al material en Drive: ${t.folderMaterial}` : "Sin material adjunto";
            
            icsContent += "BEGIN:VEVENT\n";
            icsContent += `SUMMARY: ${t.subject} - ${t.name}\n`;
            icsContent += `DTSTART;VALUE=DATE:${dateStr}\n`;
            icsContent += `DESCRIPTION:${desc}\n`;
            icsContent += "END:VEVENT\n";
        });
        
        icsContent += "END:VCALENDAR";
        
        const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `Tareas_${new Date().toISOString().split('T')[0]}.ics`;
        link.click();
    });

    // --- RENDERIZADO Y DASHBOARD ---
    function updateDashboard() {
        const subjects = [...new Set(tasks.map(t => t.subject))];
        const current = filterSubject.value;
        filterSubject.innerHTML = '<option value="all">Todas las asignaturas</option>';
        const dl = document.getElementById('subject-list'); if(dl) dl.innerHTML = '';
        
        subjects.sort().forEach(s => {
            filterSubject.appendChild(new Option(s, s));
            if(dl) dl.appendChild(new Option(s, s));
        });
        filterSubject.value = subjects.includes(current) ? current : 'all';
        renderTasks();
        renderCalendar();
    }

    function renderTasks() {
        taskList.innerHTML = '';
        let filtered = filterSubject.value === 'all' ? tasks : tasks.filter(t => t.subject === filterSubject.value);
        if (selectedDateFilter) filtered = filtered.filter(t => t.date === selectedDateFilter);
        
        filtered.sort((a,b) => new Date(a.date) - new Date(b.date)).forEach(t => {
            const li = document.createElement('li');
            li.className = `task-item ${t.completed ? 'completed' : ''}`;
            const link = t.fileMaterial || t.folderMaterial;
            li.innerHTML = `
                <div class="task-info">
                    <strong>${t.name}</strong><span>📚 ${t.subject} | 📅 ${t.date}</span>
                    <div class="task-material">${link ? `📎 <a href="${link}" target="_blank">Ver Material</a>` : 'Sin material'}</div>
                </div>
                <div class="task-actions">
                    <button class="btn-action" onclick="toggleComplete('${t.id}')">✔️</button>
                    <button class="btn-action" onclick="editTask('${t.id}')">✏️</button>
                    <button class="btn-action" onclick="deleteTask('${t.id}')">🗑️</button>
                </div>`;
            taskList.appendChild(li);
        });
    }

    // --- FUNCIONES GLOBALES ---
    window.toggleComplete = async (id) => {
        const t = tasks.find(x => x.id === id);
        await updateDoc(doc(db, "academicTasks", id), { completed: !t.completed });
    };
    window.deleteTask = async (id) => { if(confirm("¿Eliminar esta tarea?")) await deleteDoc(doc(db, "academicTasks", id)); };
    window.editTask = (id) => {
        const t = tasks.find(x => x.id === id);
        document.getElementById('task-name').value = t.name;
        document.getElementById('task-subject').value = t.subject;
        document.getElementById('task-date').value = t.date;
        editingId = id;
        submitBtn.innerHTML = 'Actualizar Tarea';
        cancelEditBtn.classList.remove('hidden');
    };
    function exitEditMode() { editingId = null; submitBtn.innerHTML = 'Guardar Tarea'; cancelEditBtn.classList.add('hidden'); }

    // --- CALENDARIO ---
    function renderCalendar() {
        calendarDays.innerHTML = '';
        const first = new Date(currentYear, currentMonth, 1).getDay();
        const offset = first === 0 ? 6 : first - 1;
        const days = new Date(currentYear, currentMonth + 1, 0).getDate();
        const months = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
        monthYearDisplay.textContent = `${months[currentMonth]} ${currentYear}`;
        for (let i = 0; i < offset; i++) calendarDays.appendChild(document.createElement('div')).className = 'calendar-day empty';
        for (let i = 1; i <= days; i++) {
            const d = document.createElement('div'); d.className = 'calendar-day'; d.textContent = i;
            const ds = `${currentYear}-${String(currentMonth+1).padStart(2,'0')}-${String(i).padStart(2,'0')}`;
            if (ds === new Date().toISOString().split('T')[0]) d.classList.add('today');
            if (selectedDateFilter === ds) d.classList.add('selected');
            d.onclick = () => { selectedDateFilter = selectedDateFilter === ds ? null : ds; updateDashboard(); };
            const dt = tasks.filter(t => t.date === ds);
            if (dt.length > 0) {
                const m = document.createElement('div'); m.className = 'markers-container';
                dt.slice(0,3).forEach(t => { const dot = document.createElement('div'); dot.className = `task-marker ${t.completed ? 'done' : ''}`; m.appendChild(dot); });
                d.appendChild(m);
            }
            calendarDays.appendChild(d);
        }
    }

    document.getElementById('prev-month').onclick = () => { currentMonth--; if(currentMonth<0){currentMonth=11;currentYear--;} renderCalendar(); };
    document.getElementById('next-month').onclick = () => { currentMonth++; if(currentMonth>11){currentMonth=0;currentYear++;} renderCalendar(); };

    function initTheme() {
        if (localStorage.getItem('darkMode') === 'enabled') document.body.classList.add('dark-mode');
        themeToggle.onclick = () => {
            document.body.classList.toggle('dark-mode');
            localStorage.setItem('darkMode', document.body.classList.contains('dark-mode') ? 'enabled' : 'disabled');
        };
    }
});
