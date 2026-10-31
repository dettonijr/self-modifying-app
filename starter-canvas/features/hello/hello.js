// Example feature: a greeting that waves back when clicked.
const root = document.getElementById("hello");

const greeting = document.createElement("p");
greeting.textContent = "Hello! Send a Prompt from the Console to change this page.";

const button = document.createElement("button");
let waves = 0;
button.textContent = "Wave";
button.addEventListener("click", () => {
  waves += 1;
  button.textContent = `Wave 👋 ×${waves}`;
});

root.append(greeting, button);
