const socket = io();

let currentRoom = null;
let meId = null;

const nameInput = document.getElementById('name');
const createBtn = document.getElementById('create');
const joinBtn = document.getElementById('join');
const joinCodeInput = document.getElementById('joinCode');
const roomArea = document.getElementById('roomArea');
const roomCodeEl = document.getElementB
