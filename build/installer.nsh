; ScènePro : raccourcis supplémentaires pour les postes autonomes
!macro customInstall
  CreateShortCut "$DESKTOP\ScènePro Synthé.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--synthe" "$INSTDIR\resources\icons\synthe.ico" 0
  CreateShortCut "$DESKTOP\ScènePro Diffusion.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--diffusion" "$INSTDIR\resources\icons\diffusion.ico" 0
  CreateShortCut "$DESKTOP\ScènePro Enregistrement.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--enregistreur" "$INSTDIR\resources\icons\enregistreur.ico" 0
  CreateShortCut "$SMPROGRAMS\ScènePro Enregistrement.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--enregistreur" "$INSTDIR\resources\icons\enregistreur.ico" 0
  CreateShortCut "$SMPROGRAMS\ScènePro Synthé.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--synthe" "$INSTDIR\resources\icons\synthe.ico" 0
  CreateShortCut "$SMPROGRAMS\ScènePro Diffusion.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--diffusion" "$INSTDIR\resources\icons\diffusion.ico" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\ScènePro Synthé.lnk"
  Delete "$DESKTOP\ScènePro Diffusion.lnk"
  Delete "$DESKTOP\ScènePro Enregistrement.lnk"
  Delete "$SMPROGRAMS\ScènePro Enregistrement.lnk"
  Delete "$SMPROGRAMS\ScènePro Synthé.lnk"
  Delete "$SMPROGRAMS\ScènePro Diffusion.lnk"
!macroend