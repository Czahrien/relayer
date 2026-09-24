import "@fontsource-variable/fraunces";
import "@fontsource-variable/public-sans";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";

mount(App, { target: document.getElementById("app")! });
